/* ============================================================
   core.js — utilitários compartilhados
   1. Utilitários    — uuid, esc, tipos
   2. Armazenamento  — IndexedDB, arquivos
   3. Documento      — normalização e busca na árvore
   4. UI             — toast, cópia, tela inicial, janelas, menus, sidebar
   5. Drag-and-drop  — ghost + auto-scroll (mouse e toque)
   6. Fórmulas       — em formula.js
   ============================================================ */

/* ============================================================
   1. UTILITÁRIOS
   ============================================================ */

function uuid() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const isAbort = err => err?.name === 'AbortError';

// Metadados de cada tipo: classe de cor e badge da sidebar; tag e rótulo vêm do dicionário (i18n)
const TYPES = Object.fromEntries(Object.entries({
  block:       ['tag-block',    'C'],
  topic:       ['tag-topic',    'T'],
  description: ['tag-desc',     'D'],
  item:        ['tag-item',     'I'],
  text:        ['tag-text',     'TX'],
  obs:         ['tag-obs',      'O'],
  keyvalue:    ['tag-keyvalue', 'KV'],
  table:       ['tag-table',    'TB'],
  checklist:   ['tag-check',    'CK'],
  image:       ['tag-image',    'IM'],
  video:       ['tag-video',    'VD'],
  audio:       ['tag-audio',    'AU'],
  divider:     ['tag-space',    '—'],
  spacer:      ['tag-space',    '␣'],
  summary:     ['tag-summary',  'SM'],
  grid:        ['tag-grid',     'G'],
  chapter:     ['tag-chapter',  'CAP'],
  gridcol:     ['tag-grid',     'G'],   // coluna do grid: nó interno, não aparece sozinho
}).map(([type, [cls, nav]]) => [type, {
  cls, nav,
  get tag()   { return t(`tag.${type}`); },
  get label() { return t(`type.${type}`); },
}]));

// Tipos que podem entrar num contêiner / num tópico (ordem do menu "Adicionar")
// Espaços (14c) são uma categoria à parte: no menu Adicionar vêm depois de um separador e não aparecem na sidebar
const SPACE_TYPES = ['divider', 'spacer'];
const ITEM_TYPES  = ['description', 'topic', 'item', 'text', 'obs', 'keyvalue', 'summary', 'table', 'checklist', 'image', 'video', 'audio', 'grid', ...SPACE_TYPES];
const MAX_TOPIC_DEPTH = 4;   // tópico dentro de tópico, até 4 níveis (12c)

// Marcadores do item de lista (o balão de símbolos) e contorno: só a tabela tem por padrão
const ITEM_MARKERS = ['•', '>', '<', '-', '$', '@', '→', '★', '✓', '✗', '+', '#', '!', '?', '◆', '○'];
const itemMarker = node => node.marker || '•';
const hasBorder  = node => node.border ?? node.type === 'table';

// Atalhos Ctrl+Alt+letra (10c): criam logo depois do selecionado. Pela tecla física (e.code),
// para funcionar em qualquer layout — no ABNT2, Ctrl+Alt é o AltGr, e só vale fora da edição de texto.
const CREATE_KEYS = {
  block: 'C', topic: 'T', description: 'D', item: 'I', text: 'X', obs: 'O',
  keyvalue: 'K', table: 'B', checklist: 'L', image: 'M', video: 'V', summary: 'S', grid: 'G',
  audio: 'A', divider: 'H', spacer: 'E', chapter: 'P',
};

// Destaques (15b): configuração de itens e contêineres
const HIGHLIGHTS = ['spoiler', 'alert', 'question'];
// Tipo de dado de uma coluna da tabela (15d): genérico (null) aceita tudo; célula fora do tipo fica marcada
const DATA_KINDS = {
  number:  /^[+-]?\d+(?:[.,]\d+)?$/,
  integer: /^[+-]?\d+$/,
  percent: /^[+-]?\d+(?:[.,]\d+)?\s?%$/,
  money:   /^[+-]?\s?(?:R\$|US\$|\$|€|£)?\s?\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{1,2})?$|^[+-]?\s?(?:R\$|US\$|\$|€|£)?\s?\d+(?:[.,]\d{1,2})?$/,
};
const cellValid = (value, kind) => !kind || !String(value ?? '').trim() || DATA_KINDS[kind].test(String(value).trim());

// Opções dos espaços e do áudio (o primeiro valor de cada lista é o padrão, que não é gravado)
const DIVIDER_WIDTHS = [100, 75, 50, 25];
const DIVIDER_STYLES = ['solid', 'dashed', 'dotted', 'double'];
const SPACER_SIZES   = { md: 32, sm: 14, lg: 56, xl: 96 };   // px na tela
const AUDIO_LOOKS    = ['wave', 'line'];                     // onda (Deezer) ou linha (Spotify)
const AUDIO_SPEEDS   = [1, 1.5, 2];

// Formatar (cor, tamanho, fonte) e alinhamento. Valem para o item inteiro (node.format) ou para uma
// coluna (node.columns[i], na tabela e no chave-valor). O padrão nunca é gravado.
const FORMAT_COLORS = { green: '0A7A47', blue: '0B5CAD', pink: 'B8245F', yellow: '8A6D00', orange: 'B35C00', purple: '6A2FC0', gray: '666666' };   // cor no papel (DOCX/impressão)
const FORMAT_SIZES  = { sm: 0.85, lg: 1.25, xl: 1.5 };                       // multiplicador; normal = 1
const FORMAT_FONTS  = { display: 'Syne', sans: 'Segoe UI', serif: 'Georgia' };  // mono (JetBrains Mono) é o padrão
const ALIGNS        = ['left', 'center', 'right'];
const MEDIA_FITS    = ['contain', 'cover', 'fill', 'none'];                    // ajustar (padrão), preencher, esticar, original

// Coloca o formato no elemento (data-color/size/font + alinhamento); o CSS faz o resto
function applyFormat(el, fmt) {
  if (!fmt) return;
  if (fmt.color) el.dataset.color = fmt.color;
  if (fmt.size)  el.dataset.size  = fmt.size;
  if (fmt.font)  el.dataset.font  = fmt.font;
  if (fmt.align) el.style.textAlign = fmt.align;
}

/* ============================================================
   2. ARMAZENAMENTO
   ============================================================ */

// ── IndexedDB ────────────────────────────────────────────────
// Banco "Wizard": kv (preferências, documento atual…) e documents (um registro por documento).
// O histórico (Undo/Redo) tem um banco separado, em docs.js.
const DB_NAME  = 'Wizard';
const DB_STORE = 'kv';
const DOCS_STORE  = 'documents';
const KEY_FILE    = 'gdd-file';       // arquivo lembrado pela versão anterior (antes da fase 1)

let _dbPromise = null;

function openDB() {
  _dbPromise ??= new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE))   db.createObjectStore(DB_STORE);
      if (!db.objectStoreNames.contains(DOCS_STORE)) db.createObjectStore(DOCS_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
  return _dbPromise;
}

async function idbTx(mode, fn, store = DB_STORE) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req?.result ?? null);
    tx.onerror    = () => rej(tx.error);
  });
}

const idbSave   = (key, val) => idbTx('readwrite', s => s.put(val, key));
const idbLoad   = key        => idbTx('readonly',  s => s.get(key));
const idbDelete = key        => idbTx('readwrite', s => s.delete(key));

// ── Arquivos ─────────────────────────────────────────────────
const JSON_TYPES = [{ description: 'Wizard JSON', accept: { 'application/json': ['.json'] } }];

const stripBOM = text => text.replace(/^\uFEFF/, '');

// Escolher um .json pelo seletor simples do navegador (Firefox e Safari não têm o de arquivos do Chrome/Edge)
function pickJsonFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

async function writeFile(fh, content) {
  if (typeof fh.createWritable !== 'function') throw new Error(t('media.noWrite'));   // ex.: Safari (18e)
  const w = await fh.createWritable({ keepExistingData: false });
  await w.write(content);
  await w.close();
}

function downloadText(text, name, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Nome seguro para arquivo (sem caracteres proibidos no Windows)
const safeFileName = name => String(name || 'documento').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'documento';

/* ============================================================
   3. DOCUMENTO
   ============================================================ */

// Percorre blocos → conteúdo → header/rows/tarefas. fn retorna true para parar.
function walkNodes(nodes, fn, parent = null) {
  for (const n of nodes || []) {
    if (!n || typeof n !== 'object') continue;
    if (fn(n, parent) === true) return true;
    if (Array.isArray(n.content) && walkNodes(n.content, fn, n)) return true;
    for (const h of n.header || []) if (fn(h, n) === true) return true;
    for (const r of n.rows   || []) if (fn(r, n) === true) return true;
    for (const c of n.items  || []) if (fn(c, n) === true) return true;
  }
  return false;
}

function findNode(blocks, id) {
  let found = null;
  walkNodes(blocks, n => { if (n.id === id) { found = n; return true; } });
  return found;
}

// Aceita JSON de versões anteriores: tipos em maiúsculas, "note" → "obs", ids ausentes
function normalizeDoc(data) {
  const list = (Array.isArray(data) ? data : [data]).filter(b => b && typeof b === 'object');
  list.forEach(b => { if (!b.type && Array.isArray(b.content)) b.type = 'block'; });
  walkNodes(list, n => {
    if (typeof n.type === 'string') {
      n.type = n.type.toLowerCase();
      if (n.type === 'note') n.type = 'obs';
    }
    if (!n.id) n.id = uuid();
  });
  return list;
}

/* ============================================================
   4. UI
   ============================================================ */

// ── Toast empilhado ──────────────────────────────────────────
// action: { label, run } → botão no aviso (que fica mais tempo na tela e fecha ao clicar)
function toast(title, msg = '', { action = null, ms = action ? 12000 : 3000 } = {}) {
  let box = document.getElementById('toast-container');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-container';
    document.body.appendChild(box);
  }
  const item = document.createElement('div');
  item.className = 'toast-item';
  item.innerHTML = `<h2>${esc(title)}</h2>${msg ? `<p>${esc(msg)}</p>` : ''}`;
  const close = () => {
    item.classList.remove('active');
    item.addEventListener('transitionend', () => item.remove(), { once: true });
  };
  if (action) {
    item.classList.add('has-action');
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { close(); action.run(); });
    item.appendChild(btn);
  }
  box.prepend(item);
  item.getBoundingClientRect(); // força reflow para a transição
  item.classList.add('active');
  setTimeout(close, ms);
}

// Pede ao navegador para não apagar os dados do Wizard numa limpeza de espaço (B19). Uma vez por sessão.
let _storageKept = false;
function keepStorage() {
  if (_storageKept) return;
  _storageKept = true;
  navigator.storage?.persist?.().catch(() => {});
}

// ── Copiar (botão direito) com bolha no cursor ───────────────
function copyText(text, e, label = t('copy.id')) {
  e?.preventDefault();
  if (!text) return;
  navigator.clipboard?.writeText(text).then(() => {
    if (!e) return toast(label, text);
    const b = document.createElement('div');
    b.className = 'copy-bubble';
    b.textContent = label;
    b.style.left = e.clientX + 'px';
    b.style.top  = e.clientY + 'px';
    document.body.appendChild(b);
    requestAnimationFrame(() => b.classList.add('visible'));
    setTimeout(() => {
      b.classList.remove('visible');
      b.addEventListener('transitionend', () => b.remove(), { once: true });
    }, 1100);
  });
}

// ── Tela inicial ─────────────────────────────────────────────
// opts: { title, subtitle, handle, actions: [{ label, icon, primary, disabled, title, run }], cancel }
function showLoadScreen(opts) {
  const ls = document.getElementById('load-screen');
  ls.classList.remove('hidden');
  ls.innerHTML = `
    <div class="ls-logo">${opts.title}</div>
    <div class="ls-subtitle">${esc(opts.subtitle)}</div>
    ${opts.handle ? `<div class="ls-file">📄 ${esc(opts.handle.name)}</div>` : ''}
    <div class="ls-actions"></div>
    ${opts.note ? `<div class="ls-note">${esc(opts.note)}</div>` : ''}
    <div class="ls-creator">${esc(t('ls.creator'))} <span>VII Solutions</span></div>`;

  const box = ls.querySelector('.ls-actions');
  const actions = opts.actions.filter(Boolean);
  if (opts.cancel) actions.push({ label: t('action.cancel'), run: hideLoadScreen });

  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.className = a.primary ? 'ls-btn-primary' : 'ls-btn-secondary';
    btn.innerHTML = `${a.icon || ''}<span>${esc(a.label)}</span>`;
    if (a.title) btn.title = a.title;
    if (a.disabled) btn.setAttribute('aria-disabled', 'true');
    btn.addEventListener('click', async () => {
      try { await a.run(); }
      catch (err) { if (!isAbort(err)) { console.warn(err); toast('⚠', err.message); } }
    });
    box.appendChild(btn);
  });
}

function hideLoadScreen() {
  document.getElementById('load-screen')?.classList.add('hidden');
}

// ── Janela de escolha (substitui confirm() quando há mais de 2 opções) ──
// options: [{ value, label, primary, danger }] → resolve com o value clicado (Esc = último)
function askChoice({ title, message, options }) {
  return new Promise(resolve => {
    const opts = options.filter(Boolean);
    const overlay = document.createElement('div');
    overlay.className = 'wz-modal';
    overlay.innerHTML = `
      <div class="wz-modal-box" role="dialog" aria-modal="true">
        <div class="wz-modal-title">${esc(title)}</div>
        <div class="wz-modal-msg">${esc(message)}</div>
        <div class="wz-modal-actions"></div>
      </div>`;
    const box = overlay.querySelector('.wz-modal-actions');

    const close = value => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = e => { if (e.key === 'Escape') close(opts[opts.length - 1].value); };

    opts.forEach(o => {
      const btn = document.createElement('button');
      btn.className = o.primary ? 'ls-btn-primary' : o.danger ? 'ls-btn-secondary danger' : 'ls-btn-secondary';
      btn.textContent = o.label;
      btn.addEventListener('click', () => close(o.value));
      box.appendChild(btn);
    });

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    box.querySelector('button')?.focus();
  });
}

// ── Janela para digitar um texto (renomear…) → resolve com o texto ou null (cancelado) ──
// multiline: caixa de texto (Enter quebra linha, Ctrl+Enter confirma)
function askText({ title, value = '', okLabel = 'OK', multiline = false, placeholder = '' }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'wz-modal';
    overlay.innerHTML = `
      <div class="wz-modal-box" role="dialog" aria-modal="true">
        <div class="wz-modal-title">${esc(title)}</div>
        ${multiline ? '<textarea class="wz-modal-input" rows="4"></textarea>' : '<input class="wz-modal-input" type="text">'}
        <div class="wz-modal-actions">
          <button class="ls-btn-primary" data-v="ok">${esc(okLabel)}</button>
          <button class="ls-btn-secondary" data-v="cancel">${esc(t('action.cancel'))}</button>
        </div>
      </div>`;
    const input = overlay.querySelector('.wz-modal-input');
    input.value = value;
    input.placeholder = placeholder;
    const close = ok => { overlay.remove(); resolve(ok ? input.value : null); };
    overlay.querySelector('[data-v=ok]').addEventListener('click', () => close(true));
    overlay.querySelector('[data-v=cancel]').addEventListener('click', () => close(false));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
    });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

// ── Menu de contexto (clique direito / toque longo) ──────────
// items: [{ label, run, danger }] · fecha ao clicar fora, rolar ou Esc
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'wz-menu';
  menu.setAttribute('role', 'menu');
  // '-' é um separador (sem separador sobrando no começo, no fim ou repetido)
  items.filter(Boolean).filter((item, i, all) => item !== '-' || (i > 0 && all[i - 1] !== '-' && all.slice(i + 1).some(x => x !== '-'))).forEach(item => {
    if (item === '-') {
      const sep = document.createElement('div');
      sep.className = 'wz-menu-sep';
      sep.setAttribute('role', 'separator');
      return menu.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'wz-menu-item' + (item.danger ? ' danger' : '');
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (item.hint) btn.insertAdjacentHTML('beforeend', `<span class="wz-menu-hint">${esc(item.hint)}</span>`);   // atalho de teclado
    if (item.disabled) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); return menu.appendChild(btn); }
    btn.addEventListener('click', async () => {
      closeContextMenu();
      try { await item.run(); }
      catch (err) { if (!isAbort(err)) { console.warn(err); toast('⚠', err.message); } }
    });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);

  // Mantém o menu dentro da tela
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth  - r.width  - 4)) + 'px';
  menu.style.top  = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  menu.querySelector('button:not(:disabled)')?.focus();

  setTimeout(() => {
    document.addEventListener('pointerdown', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('scroll', closeContextMenu, { once: true, capture: true });
  });
}

function closeContextMenu() {
  document.querySelector('.wz-menu')?.remove();
  document.removeEventListener('pointerdown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
const onMenuOutside = e => { if (!e.target.closest('.wz-menu')) closeContextMenu(); };
const onMenuKey     = e => { if (e.key === 'Escape') closeContextMenu(); };

// Clique direito no mouse e toque longo (≈500 ms) no toque chamam o mesmo fn(x, y, alvo)
function onContextAction(el, fn) {
  el.addEventListener('contextmenu', e => { e.preventDefault(); fn(e.clientX, e.clientY, e.target); });
  let timer = null, start = null;
  el.addEventListener('touchstart', e => {
    const p = e.touches[0];
    start = { x: p.clientX, y: p.clientY, target: e.target };
    timer = setTimeout(() => { timer = null; fn(start.x, start.y, start.target); }, 500);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('touchmove', e => {
    const p = e.touches[0];
    if (start && Math.hypot(p.clientX - start.x, p.clientY - start.y) > 10) cancel();
  }, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
}

// ── Sidebar: mostrar / ocultar ───────────────────────────────
function initSidebarToggle() {
  const sidebar = document.querySelector('.sidebar');
  const main    = document.querySelector('.main-content-area');
  const showBtn = document.getElementById('btn-show-sidebar');
  if (!sidebar) return;

  const collapse = () => {
    sidebar.classList.add('collapsed');
    sidebar.classList.remove('mobile-open');
    main?.classList.add('expanded');
    showBtn?.classList.add('visible');
  };
  const expand = () => {
    sidebar.classList.remove('collapsed');
    sidebar.classList.add('mobile-open');
    main?.classList.remove('expanded');
    showBtn?.classList.remove('visible');
  };

  document.getElementById('btn-collapse-sidebar')?.addEventListener('click', collapse);
  showBtn?.addEventListener('click', expand);

  const mq = window.matchMedia('(max-width: 768px)');
  mq.addEventListener('change', e => e.matches ? collapse() : expand());
  if (mq.matches) collapse();
}

// ── Sidebar: árvore de navegação (mesma estrutura nas duas páginas) ──
const navCollapsed = new Set(); // ids recolhidos sobrevivem aos rebuilds

function navLabel(node) {
  const raw = node.type === 'item' ? node.text
    : 'src' in node ? (node.caption || String(node.src || '').replace(/^\.\//, ''))   // imagem/vídeo: legenda ou nome do arquivo
    : Array.isArray(node.content) && node.title == null ? ''   // grid: sem título, mostra o tipo
    : (node.title ?? node.content);
  // Fórmulas `f{…}` aparecem como o texto que representam (formula.js)
  const text = typeof plainText === 'function' ? plainText(raw, Docs.current?.blocks || [], { self: node }) : raw;
  return String(text || TYPES[node.type]?.label || node.type || '').slice(0, 40);
}

function navLink(node, prefix, cls) {
  const a = document.createElement('a');
  a.className = cls;
  a.href = `#${prefix}${node.id}`;
  a.dataset.anchor = prefix + node.id;
  const meta = TYPES[node.type] || TYPES.item;
  const badge = node.type === 'block'
    ? `<span class="tag tag-block">${TYPES.block.nav}</span>`
    : `<span class="nav-badge ${meta.cls}">${meta.nav}</span>`;
  a.innerHTML = `${badge}<span class="nav-text">${esc(navLabel(node))}</span>`;
  return a;
}

function navGroupHeader(node, prefix, cls, kids) {
  const row    = document.createElement('div');
  const toggle = document.createElement('span');
  const open   = !navCollapsed.has(node.id);
  row.className    = 'nav-group-header';
  toggle.className = 'nav-group-toggle' + (open ? ' open' : '');
  toggle.textContent = '▶';
  kids.classList.toggle('open', open);
  toggle.addEventListener('click', e => {
    e.preventDefault();
    const isOpen = kids.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
    isOpen ? navCollapsed.delete(node.id) : navCollapsed.add(node.id);
  });
  row.append(toggle, navLink(node, prefix, cls));
  return row;
}

// Filhos na árvore: a coluna do grid não aparece, os itens dela sobem para o grid
const navChildren = n => n.type === 'grid' ? (n.content || []).flatMap(col => col.content || []) : (n.content || []);

function renderNavTree(nav, blocks, prefix) {
  nav.innerHTML = '';
  // Tópicos (em qualquer nível) e grids abrem um grupo recolhível
  const addItems = (list, parent, depth) => {
    for (const item of list) {
      if (SPACE_TYPES.includes(item.type)) continue;   // divisores e espaçamentos não entram na árvore
      if (item.type === 'topic' || item.type === 'grid') {
        const leaves = document.createElement('div');
        leaves.className = 'nav-children';
        addItems(navChildren(item), leaves, depth + 1);
        parent.append(navGroupHeader(item, prefix, `${depth ? 'nav-leaf-item' : 'nav-sub-item'} nav-topic`, leaves), leaves);
      } else {
        parent.appendChild(navLink(item, prefix, depth ? 'nav-leaf-item' : 'nav-sub-item'));
      }
    }
  };
  const addBlock = (block, into) => {
    const group = document.createElement('div');
    const kids  = document.createElement('div');
    group.className = 'nav-block-group';
    kids.className  = 'nav-children';
    if (block.type === 'chapter') {   // capítulo (15a): um grupo com os seus contêineres
      group.classList.add('nav-chapter-group');
      (block.content || []).forEach(b => addBlock(b, kids));
      group.append(navGroupHeader(block, prefix, 'nav-block-item nav-chapter', kids), kids);
    } else {
      addItems(navChildren(block), kids, 0);
      group.append(navGroupHeader(block, prefix, 'nav-block-item', kids), kids);
    }
    into.appendChild(group);
  };
  blocks.forEach(block => addBlock(block, nav));
}

// Destaca na sidebar o que está na linha de leitura (25% da altura da tela), em todos os níveis (B13):
// o mais de dentro fica "active"; os que o contêm (capítulo, contêiner, tópico) ficam "active-trail"
const NAV_PROBE = 0.25;
let navSelector = null, navFrame = 0, navLast = null;

function observeNav(selector) {
  navSelector = selector;
  if (!observeNav.bound) {
    observeNav.bound = true;
    const later = () => { cancelAnimationFrame(navFrame); navFrame = requestAnimationFrame(updateNavActive); };
    window.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
  }
  updateNavActive();
}

function updateNavActive() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav || !navSelector) return;
  const y = innerHeight * NAV_PROBE;
  const linkOf = el => el.id && nav.querySelector(`a[data-anchor="${CSS.escape(el.id)}"]`);
  // Na ordem do documento: quem contém vem antes de quem está dentro
  const chain = [...document.querySelectorAll(navSelector)]
    .filter(el => { const r = el.getBoundingClientRect(); return r.top <= y && r.bottom >= y; })
    .map(linkOf).filter(Boolean);
  nav.querySelectorAll('a.active, a.active-trail').forEach(a => a.classList.remove('active', 'active-trail'));
  chain.forEach((a, i) => a.classList.add(i === chain.length - 1 ? 'active' : 'active-trail'));

  // Mantém o destaque à vista, rolando só a sidebar (não a página)
  const cur = chain.at(-1);
  if (cur && cur !== navLast) {
    navLast = cur;
    const box = nav.getBoundingClientRect(), r = cur.getBoundingClientRect();
    if (r.top < box.top) nav.scrollTop -= box.top - r.top + 8;
    else if (r.bottom > box.bottom) nav.scrollTop += r.bottom - box.bottom + 8;
  }
}

function flashEl(el) {
  el.classList.remove('flash');
  el.getBoundingClientRect();
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

/* ============================================================
   5. DRAG-AND-DROP
   ============================================================ */

// Cria um ghost menor que segue o cursor (ou o dedo), esconde o original e rola a página
// perto das bordas. onMove(e) reposiciona o original; onEnd() finaliza.
// Usa pointer events: funciona com mouse, caneta e toque (a alça precisa de touch-action: none).
function startGhostDrag(e, el, { onMove, onEnd }) {
  e.preventDefault();
  const pointerId = e.pointerId;
  const rect = el.getBoundingClientRect();
  const offX = e.clientX - rect.left;
  const offY = e.clientY - rect.top;

  const ghost = el.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  ghost.className = 'drag-ghost';
  ghost.style.width = rect.width + 'px';
  document.body.appendChild(ghost);
  el.classList.add('drag-source');

  let last = e, scrollDir = 0;
  const place = ev => {
    ghost.style.left = ev.clientX - offX + 'px';
    ghost.style.top  = ev.clientY - offY + 'px';
  };
  place(e);

  const timer = setInterval(() => {
    if (!scrollDir) return;
    window.scrollBy(0, scrollDir * 14);
    onMove(last);
  }, 16);

  const move = ev => {
    if (ev.pointerId !== pointerId) return;
    ev.preventDefault();
    last = ev;
    place(ev);
    const thr = 80;
    scrollDir = ev.clientY < thr ? -1 : ev.clientY > window.innerHeight - thr ? 1 : 0;
    onMove(ev);
  };
  const up = ev => {
    if (ev.pointerId !== pointerId) return;
    clearInterval(timer);
    ghost.remove();
    el.classList.remove('drag-source');
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    onEnd?.();
  };

  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

// Move dragEl dentro de container para a posição correspondente ao Y do cursor
function placeByY(container, dragEl, y, selector) {
  const sibs = [...container.querySelectorAll(selector)].filter(s => s !== dragEl);
  for (const s of sibs) {
    const r = s.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      if (s.previousElementSibling !== dragEl) s.before(dragEl);
      return;
    }
  }
  const last = sibs[sibs.length - 1];
  if (!last) { if (dragEl.parentElement !== container) container.prepend(dragEl); }
  else if (last.nextElementSibling !== dragEl) last.after(dragEl);
}

