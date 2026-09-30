/* ============================================================
   editor.js — tela única do Wizard (edição + visualização)

   · Duplo clique (ou toque duplo) edita só aquele campo; Enter salva,
     Shift+Enter quebra linha, Esc cancela.
   · Clique simples não edita: segue links de fórmula e seleciona texto.
   · Clique direito (ou toque longo) abre o menu com as operações.
   · ⠿ arrasta contêineres e itens (mouse e toque); linhas de tabela
     mudam de ordem pelo menu da linha.
   · Menus: o que é exclusivo do tipo fica em cima; depois de um
     separador, o que é comum a todos (editar, configurar, duplicar…).
   · Cada alteração vai para o IndexedDB na hora; o arquivo só muda no Salvar.

   O editor é dividido por área (scripts clássicos, carregados antes deste):
     editor-sidebar.js  sinais da sidebar e ⚙ Configurações
     editor-media.js    imagem, galeria, vídeo, áudio, pasta do projeto, soltar arquivos
     editor-menus.js    menus, Configurar item e Formatar
     editor-edit.js     edição inline, navegação, operações estruturais, arrastar, seleção
   Este arquivo: desenho do documento e dos itens, troca de documento, desfazer e o início.
   ============================================================ */

const mainEl = () => document.getElementById('editor-main');
const blocks = () => Docs.current.blocks;

/* ============================================================
   RENDER
   ============================================================ */

/* Redesenho (B23). Ao abrir um documento, trocar de idioma ou liberar a pasta das mídias, a tela é montada
   do zero (com a animação de entrada dos cards). Nas outras vezes (criar, excluir, mover, desfazer, outra aba…)
   só as partes do nível de cima que mudaram — contêineres, grids, capítulos e os contêineres dentro deles —
   são refeitas, sem animação; o resto da página (mídias, linhas de página, rolagem) fica como está.
   Uma parte só é reaproveitada se for o MESMO objeto com o MESMO conteúdo: os campos guardam a referência do nó. */
const drawn = new Map();   // id → { node, json, el } do último desenho
let drawnKey = null;       // documento e idioma do último desenho completo

function renderEditor({ keepScroll = true, full = false } = {}) {
  // Documento, idioma e acesso às mídias (pasta ligada, cópias esquecidas): se mudou, tudo de novo
  const key = `${Docs.current.id}|${LANG}|${Docs.current.dirHandle ? 'pasta' : '-'}|${typeof Media === 'undefined' ? 0 : Media.epoch}`;
  if (full || key !== drawnKey || !mainEl().querySelector(':scope > .doc-title')) return renderFull(keepScroll, key);
  patchEditor();
}

function renderFull(keepScroll, key) {
  const y = window.scrollY;
  const main = mainEl();
  main.innerHTML = '';
  main.appendChild(buildDocTitle());
  if (!blocks().length) main.appendChild(buildEmpty());
  // Nível de cima: contêineres, grids (12b) e capítulos (15a); a numeração #01, #02… conta só os contêineres
  const counter = { n: 0 };
  blocks().forEach(block => main.appendChild(buildTopLevel(block, counter)));
  main.appendChild(buildAddContainer());

  drawn.clear();
  blocks().forEach(block => remember(block, main.querySelector(`:scope > [data-node-id="${CSS.escape(block.id)}"]`), drawn));
  drawnKey = key;

  renderSidebar();
  if (selectedId) select(selectedId, { scroll: false });   // a seleção sobrevive ao redesenho
  // sem o deslizar do scroll-behavior: smooth; documento aberto começa do topo
  window.scrollTo({ top: keepScroll ? y : 0, behavior: 'instant' });
  schedulePagination(0);   // linhas de quebra de página A4 (print.js)
  window.dispatchEvent(new Event('wizard:rendered'));   // a busca (search.js) recalcula os resultados
}

function patchEditor() {
  const main = mainEl();
  const anchor = scrollAnchor();
  main.querySelector(':scope > .doc-title').replaceWith(buildDocTitle());
  main.querySelector(':scope > .v-empty')?.remove();
  if (!blocks().length) main.querySelector(':scope > .doc-title').after(buildEmpty());

  const next = new Map();
  reconcile(main, blocks(), next, main.querySelector(':scope > .v-empty, :scope > .doc-title'));
  const add = main.querySelector(':scope > .btn-add-container');
  if (main.lastElementChild !== add) main.appendChild(add);
  drawn.clear();
  next.forEach((v, k) => drawn.set(k, v));

  renumber();
  refreshFormulas();   // um campo reaproveitado pode citar algo que mudou
  renderSidebar();
  if (selectedId) select(selectedId, { scroll: false });
  paginate();          // print.js: as linhas de página se ajustam no mesmo quadro, sem pular
  anchor?.();          // o que estava no topo da tela continua no mesmo lugar
  window.dispatchEvent(new Event('wizard:rendered'));
}

// Coloca em `parent` as partes de `nodes`, na ordem, reaproveitando as que não mudaram.
// `prev`: elemento logo antes da primeira parte (null = começo do parent). As linhas "Página N" são ignoradas.
function reconcile(parent, nodes, next, prev = null) {
  const kept = new Set();
  for (const node of nodes) {
    const el = partFor(node, next);
    kept.add(el);
    const expected = prev ? nextPart(prev) : firstPart(parent);
    if (expected !== el) {
      noEnter(el);   // mudar de lugar no DOM reiniciaria a animação de entrada
      if (prev) prev.after(el); else parent.prepend(el);
    }
    prev = el;
  }
  // Sai o que não está mais aqui (excluído, movido, ou a versão antiga de uma parte refeita)
  [...parent.children].forEach(c => { if (c.dataset.nodeId && !kept.has(c)) c.remove(); });
}
const isPageLine = el => el?.classList.contains('page-break-line');
function nextPart(el) { let n = el.nextElementSibling; while (isPageLine(n)) n = n.nextElementSibling; return n; }
function firstPart(parent) { let n = parent.firstElementChild; while (isPageLine(n)) n = n.nextElementSibling; return n; }

// Capítulo: o que é dele (sem os contêineres) · outras partes: tudo
const ownJson = node => node.type === 'chapter' ? JSON.stringify({ ...node, content: undefined }) : JSON.stringify(node);

function partFor(node, next) {
  const old = drawn.get(node.id);
  const same = old && old.node === node && old.el.isConnected;
  if (same && node.type === 'chapter' && old.json === ownJson(node)) {
    const body = old.el.querySelector(':scope > .chapter-body');
    reconcile(body, node.content || [], next);
    const add = body.querySelector(':scope > .btn-add-in-chapter');
    if (body.lastElementChild !== add) body.appendChild(add);
    next.set(node.id, old);
    return old.el;
  }
  if (same && old.json === ownJson(node)) { next.set(node.id, old); return old.el; }
  const el = buildTopLevel(node, { n: 0 });   // o número #NN é acertado depois (renumber)
  noEnter(el);
  if (old?.el.isConnected) old.el.replaceWith(el);   // no mesmo lugar: os seguintes não precisam se mexer
  remember(node, el, next);
  return el;
}

const noEnter = el => [el, ...el.querySelectorAll('.entry')].forEach(e => e.classList.add('no-enter'));

function remember(node, el, map) {
  if (!el) return;
  map.set(node.id, { node, json: ownJson(node), el });
  if (node.type === 'chapter') (node.content || []).forEach(b =>
    remember(b, el.querySelector(`:scope > .chapter-body > [data-node-id="${CSS.escape(b.id)}"]`), map));
}

// #01, #02… na ordem da página (só contêineres)
function renumber() {
  let n = 0;
  mainEl().querySelectorAll('.entry[data-kind="container"]').forEach(card => {
    const badge = card.querySelector(':scope > .entry-header > .entry-id-badge');
    const s = `#${String(++n).padStart(2, '0')}`;
    if (badge && badge.textContent !== s) badge.textContent = s;
  });
}

// Guarda onde está o primeiro item visível no topo da tela; a função devolvida o põe de volta no lugar
// (o primeiro que começa dentro da tela; se um item maior que a tela a cobre inteira, o mais interno dele)
function scrollAnchor() {
  const els = [...mainEl().querySelectorAll('[data-node-id]')].map(el => ({ el, r: el.getBoundingClientRect() })).filter(x => x.r.height);
  let picks = els.filter(x => x.r.top >= 0 && x.r.top < innerHeight).slice(0, 12);
  if (!picks.length) picks = els.filter(x => x.r.top < 0 && x.r.bottom > 0).reverse().slice(0, 12);
  const marks = picks.map(x => ({ id: x.el.dataset.nodeId, y: x.r.top }));
  if (!marks.length) return null;
  return () => {
    for (const m of marks) {
      const el = mainEl().querySelector(`[data-node-id="${CSS.escape(m.id)}"]`);
      if (!el) continue;
      const dy = el.getBoundingClientRect().top - m.y;
      if (dy) window.scrollBy({ top: dy, behavior: 'instant' });
      return;
    }
  };
}

function buildEmpty() {
  const empty = document.createElement('div');
  empty.className = 'v-empty';
  empty.innerHTML = `<div class="v-empty-icon">📄</div><div class="v-empty-title">${esc(t('editor.empty'))}</div>`;
  return empty;
}

function buildAddContainer() {
  const add = document.createElement('button');
  add.className = 'btn-add-container';
  add.textContent = t('editor.addContainer');
  add.addEventListener('click', () => structural(() => Model.addContainer(), { editNew: true, op: 'CRIAR_BLOCO' }));
  return add;
}

function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  renderNavTree(nav, blocks(), 'v-');
  decorateNav(nav);
  observeNav('.chapter, .entry, .v-node');   // destaca contêiner, tópico e item (B13)
  renderDocStatus(document.getElementById('doc-status'));
}

// Cria elemento com âncora (v-<id>) e data-node-id (alvo dos links de fórmula)
function vEl(tag, cls, node) {
  const el = document.createElement(tag);
  el.className = cls;
  if (node?.id) { el.id = 'v-' + node.id; el.dataset.nodeId = node.id; }
  return el;
}

// Texto do campo com as fórmulas `f{…}` resolvidas (formula.js). ctx: onde o campo está (o nó dono e,
// na tabela, a linha e a coluna; na chave-valor, a chave) — fica guardado para os próximos desenhos.
function renderRich(el, text, ctx) {
  if (ctx) el._fctx = ctx;
  const s = String(text ?? '');
  el.innerHTML = Formula.html(s, { blocks: blocks(), ...el._fctx });
  el.classList.toggle('has-formula', Formula.has(s));
}

// Re-renderiza os campos com fórmula (o alvo pode ter mudado)
function refreshFormulas() {
  mainEl().querySelectorAll('.has-formula:not(.cell-editing)').forEach(el => el._edit && renderRich(el, el._edit.get()));
}

// ── Nome do documento ─────────────────────────────────────────
function buildDocTitle() {
  const el = document.createElement('h1');
  el.className = 'doc-title';
  el.dataset.placeholder = t('doc.defaultName');
  attachInlineEdit(el, {
    get: () => Docs.current.name,
    set: v => {
      Docs.update(rec => { rec.name = v.trim() || t('doc.defaultName'); }, { op: 'ALTERAR_NOME' }).then(() => renderDocStatus(document.getElementById('doc-status')));
    },
  });
  renderRich(el, Docs.current.name);
  return el;
}

/* ── Destaque (15b) e comentário (15e) ─────────────────────────
   Spoiler: o conteúdo fica embaçado sob um vidro fosco até ser revelado (só nesta sessão).
   Alerta e dúvida: selo e borda coloridos. Comentário: invisível até passar o mouse no item
   (ou no índice dele na sidebar), ou com o item selecionado. */
const revealed = new Set();   // spoilers revelados (não vai para o arquivo)

function decorate(el, node) {
  if (node.highlight) {
    el.dataset.highlight = node.highlight;
    const badge = document.createElement('span');
    badge.className = 'hl-badge';
    badge.textContent = t(`hl.label.${node.highlight}`);
    el.appendChild(badge);
    if (node.highlight === 'spoiler') {
      el.classList.toggle('revealed', revealed.has(node.id));
      const veil = document.createElement('button');
      veil.className = 'spoiler-veil';
      veil.innerHTML = `<span>${esc(t('hl.reveal'))}</span>`;
      veil.addEventListener('click', e => { e.stopPropagation(); revealed.add(node.id); el.classList.add('revealed'); schedulePagination(); });
      el.appendChild(veil);
    }
  }
  if (node.comment) {
    const c = document.createElement('div');
    c.className = 'v-comment';
    c.setAttribute('role', 'note');
    c.textContent = node.comment;
    el.appendChild(c);
  }
}

// Destaque: nenhum · spoiler · alerta · dúvida (itens e contêineres)
const highlightMenu = node => radio(node.highlight, [null, ...HIGHLIGHTS], v => t(`hl.${v || 'none'}`), v => {
  if (v !== 'spoiler') revealed.delete(node.id);
  setItemOption(node, 'highlight', v);
});

// Comentar / editar comentário (vazio apaga)
async function editComment(node) {
  const v = await askText({ title: t('comment.title'), value: node.comment || '', okLabel: t('comment.save'), multiline: true, placeholder: t('comment.ph') });
  if (v === null) return;
  structural(() => { if (v.trim()) node.comment = v.trim(); else delete node.comment; }, { op: 'COMENTARIO' });
}
const commentEntry = node => ({ label: t(node.comment ? 'menu.editComment' : 'menu.addComment'), run: () => editComment(node) });

function buildTopLevel(block, counter) {
  if (block.type === 'grid') return buildTopGrid(block);
  if (block.type === 'chapter') return buildChapter(block, counter);
  return buildContainer(block, counter.n++);
}

// ── Capítulo (15a): hipercontêiner, só aceita contêineres ──────
function buildChapter(ch, counter) {
  const el = vEl('section', 'chapter', ch);
  el.dataset.kind = 'chapter';
  el.innerHTML = `
    <div class="chapter-header">
      <div class="entry-drag-handle drag-handle chapter-handle" title="${esc(t('editor.drag'))}">⠿</div>
      <span class="chapter-tag">${esc(t('tag.chapter'))}</span>
      <h2 class="chapter-title primary-field"></h2>
      <button class="btn-entry-menu" title="${esc(t('editor.menu'))}">⋯</button>
    </div>
    <div class="chapter-body" data-parent-id="${esc(ch.id)}"></div>`;
  editable(el.querySelector('.chapter-title'), ch, 'title', { nav: true, placeholder: t('ph.title') });
  const body = el.querySelector('.chapter-body');
  (ch.content || []).forEach(b => body.appendChild(buildContainer(b, counter.n++)));
  const add = document.createElement('button');
  add.className = 'btn-add-container btn-add-in-chapter';
  add.textContent = t('editor.addContainer');
  add.addEventListener('click', () => structural(() => {
    const last = ch.content?.at(-1);
    return last ? Model.addContainer(last.id) : ((ch.content ??= []).push(newNode('block')), ch.content.at(-1));
  }, { editNew: true, op: 'CRIAR_BLOCO' }));
  body.appendChild(add);
  el.querySelector('.btn-entry-menu').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu(r.right - 220, r.bottom, chapterMenu(el));
  });
  el.querySelector('.chapter-handle').addEventListener('pointerdown', e => dragContainer(e, el));
  decorate(el.querySelector('.chapter-header'), ch);   // comentário do capítulo
  return el;
}

// ── Contêiner ─────────────────────────────────────────────────
function buildContainer(block, index) {
  const card = vEl('div', 'entry', block);
  card.dataset.kind = 'container';
  card.style.animationDelay = `${Math.min(index, 10) * 0.04}s`;
  card.innerHTML = `
    <div class="entry-header">
      <div class="entry-drag-handle drag-handle" title="${esc(t('editor.drag'))}">⠿</div>
      <div class="entry-id-badge">#${String(index + 1).padStart(2, '0')}</div>
      <div class="entry-title primary-field"></div>
      <button class="btn-entry-menu" title="${esc(t('editor.menu'))}">⋯</button>
    </div>
    <div class="entry-body" data-parent-id="${esc(block.id)}"></div>
    <div class="entry-footer"></div>`;

  editable(card.querySelector('.entry-title'), block, 'title', { nav: true, placeholder: t('ph.title') });

  const body = card.querySelector('.entry-body');
  (block.content || []).forEach(item => body.appendChild(buildNode(item)));
  card.querySelector('.entry-footer').appendChild(addItemButton(block.id, typesFor(blocks(), block)));

  card.querySelector('.btn-entry-menu').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.right - 10, r.bottom, card);
  });
  decorate(card, block);
  card.querySelector('.entry-drag-handle').addEventListener('pointerdown', e => dragContainer(e, card));
  return card;
}

function addItemButton(parentId, types) {
  const btn = document.createElement('button');
  btn.className = 'btn-add-item';
  btn.textContent = t('editor.addItem');
  btn.addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu(r.left, r.bottom + 2, typeMenu(type => structural(() => Model.addItem(type, { parentId }), { editNew: true, op: 'CRIAR_BLOCO' }), types));
  });
  return btn;
}

// Itens em cima; os Espaços (divisor, espaçamento) depois de um separador
function typeMenu(onPick, types = ITEM_TYPES) {
  const entry = type => ({ label: `${TYPES[type].tag} · ${TYPES[type].label}`, hint: `Ctrl+Alt+${CREATE_KEYS[type]}`, run: () => onPick(type) });
  return [...types.filter(x => !SPACE_TYPES.includes(x)).map(entry), '-', ...types.filter(x => SPACE_TYPES.includes(x)).map(entry)];
}

// ── Itens ─────────────────────────────────────────────────────
// Todo item fica num invólucro .v-node com alça de arrastar
function buildNode(node) {
  const wrap = vEl('div', `v-node v-node-${node.type}`, node);
  wrap.dataset.kind = 'item';
  wrap.classList.toggle('bordered', hasBorder(node));   // sem contorno por padrão, exceto a tabela
  applyFormat(wrap, node.format);                       // cor, tamanho e fonte do item inteiro
  decorate(wrap, node);                                 // destaque (15b) e comentário (15e)
  const handle = document.createElement('span');
  handle.className = 'item-handle drag-handle';
  handle.textContent = '⠿';
  handle.title = t('editor.drag');
  handle.addEventListener('pointerdown', e => dragItem(e, wrap));
  wrap.append(handle, buildItemContent(node));
  return wrap;
}

function buildItemContent(node) {
  switch (node.type) {
    case 'description': return textBlock(node, 'v-description');
    case 'text':        return textBlock(node, 'v-text');
    case 'obs':         return labeledItem(node, 'content', true);
    case 'item':        return labeledItem(node, 'text', false);
    case 'keyvalue':    return buildKV(node);
    case 'table':       return buildTable(node);
    case 'topic':       return buildTopic(node);
    case 'checklist':   return buildChecklist(node);
    case 'summary':     return buildSummary(node);
    case 'grid':        return buildGrid(node);
    case 'image':
    case 'video':
    case 'audio':       return buildMedia(node);
    case 'divider':
    case 'spacer':      return buildSpace(node);
  }
  return document.createElement('div');
}

// Espaços (14c): só largura e desenho (divisor) ou altura (espaçamento); a cor vem do Formatar
function buildSpace(node) {
  const el = document.createElement('div');
  el.title = TYPES[node.type].label;
  if (node.type === 'divider') {
    el.className = 'v-divider';
    el.style.setProperty('--w', `${node.width || DIVIDER_WIDTHS[0]}%`);
    el.dataset.style = node.style || DIVIDER_STYLES[0];
  } else {
    el.className = 'v-spacer';
    el.style.height = `${SPACER_SIZES[node.size || 'md']}px`;
  }
  return el;
}

function textBlock(node, cls) {
  const el = document.createElement('div');
  el.className = `${cls} primary-field`;
  editable(el, node, 'content', { multiline: true, placeholder: t('ph.text') });
  return el;
}

// Observação: rótulo do tipo + texto · Item de lista: marcador (•, >, $…) + texto
function labeledItem(node, field, multiline) {
  const wrap  = document.createElement('div');
  const body  = document.createElement('div');
  wrap.className = 'v-topic-item';
  let label;
  if (node.type === 'item') {
    label = document.createElement('button');
    label.className = 'v-marker';
    label.textContent = itemMarker(node);
    label.title = t('marker.choose');
    label.setAttribute('aria-label', t('marker.choose'));
    label.setAttribute('aria-haspopup', 'true');
    label.addEventListener('click', e => { e.stopPropagation(); openMarkerBubble(label, node); });
  } else {
    label = document.createElement('span');
    label.className = `tag v-topic-item-label ${TYPES[node.type].cls}`;
    label.textContent = TYPES[node.type].tag;
  }
  body.className = 'v-topic-item-body primary-field' + (multiline ? ' v-text' : '');
  editable(body, node, field, { multiline, placeholder: t('ph.text') });
  wrap.append(label, body);
  return wrap;
}

// Balão (estilo quadrinhos) com os símbolos do marcador, apontando para o ponto clicado
function openMarkerBubble(anchor, node) {
  closeMarkerBubble();
  const bubble = document.createElement('div');
  bubble.className = 'wz-bubble';
  bubble.setAttribute('role', 'listbox');
  bubble.setAttribute('aria-label', t('marker.choose'));
  ITEM_MARKERS.forEach(sym => {
    const b = document.createElement('button');
    b.className = 'wz-bubble-sym' + (sym === itemMarker(node) ? ' current' : '');
    b.textContent = sym;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(sym === itemMarker(node)));
    b.addEventListener('click', () => {
      closeMarkerBubble();
      if (sym === itemMarker(node)) return;
      structural(() => { if (sym === '•') delete node.marker; else node.marker = sym; }, { op: 'ALTERAR_MARCADOR' });
    });
    bubble.appendChild(b);
  });
  document.body.appendChild(bubble);

  // Abaixo e à direita do ponto; a ponta do balão fica sobre ele (dentro da tela)
  const a = anchor.getBoundingClientRect(), r = bubble.getBoundingClientRect();
  const left = Math.max(4, Math.min(a.left - 14, innerWidth - r.width - 4));
  const below = a.bottom + 10 + r.height < innerHeight;
  bubble.style.left = left + 'px';
  bubble.style.top  = (below ? a.bottom + 10 : a.top - 10 - r.height) + 'px';
  bubble.style.setProperty('--tail-x', `${a.left + a.width / 2 - left}px`);
  bubble.classList.toggle('above', !below);
  bubble.querySelector('.current')?.focus();

  setTimeout(() => {
    document.addEventListener('pointerdown', onBubbleOutside, true);
    document.addEventListener('keydown', onBubbleKey, true);
    window.addEventListener('scroll', closeMarkerBubble, { once: true, capture: true });
  });
}
function closeMarkerBubble() {
  document.querySelector('.wz-bubble')?.remove();
  document.removeEventListener('pointerdown', onBubbleOutside, true);
  document.removeEventListener('keydown', onBubbleKey, true);
}
const onBubbleOutside = e => { if (!e.target.closest('.wz-bubble')) closeMarkerBubble(); };
const onBubbleKey = e => {
  if (e.key === 'Escape') return closeMarkerBubble();
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const syms = [...document.querySelectorAll('.wz-bubble-sym')];
  const i = syms.indexOf(document.activeElement);
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[e.key];
  e.preventDefault();
  syms[(i + step + syms.length) % syms.length]?.focus();
};

function buildTopic(node) {
  const el     = document.createElement('div');
  const header = document.createElement('div');
  const title  = document.createElement('div');
  el.className     = 'v-topic';
  header.className = 'v-topic-header';
  title.className  = 'v-topic-title primary-field';
  editable(title, node, 'title', { nav: true, placeholder: t('ph.title') });
  header.appendChild(title);

  const body = document.createElement('div');
  body.className = 'v-topic-body';
  body.dataset.parentId = node.id;
  (node.content || []).forEach(child => body.appendChild(buildNode(child)));
  el.append(header, body);
  // "+ Adicionar" só no tópico vazio; depois do primeiro item, o menu (clique direito) adiciona
  if (!node.content?.length) el.appendChild(addItemButton(node.id, typesFor(blocks(), node)));
  return el;
}

function buildKV(node) {
  node.data ??= {};
  const el    = document.createElement('div');
  const label = document.createElement('div');
  const grid  = document.createElement('div');
  el.className    = 'v-kv';
  label.className = 'v-kv-label primary-field';
  grid.className  = 'v-kv-grid';
  editable(label, node, 'title', { placeholder: t('ph.title') });

  Object.keys(node.data).forEach(initialKey => {
    let key = initialKey;
    const kEl   = document.createElement('div');
    const valEl = document.createElement('div');
    kEl.className   = 'v-kv-key';
    valEl.className = 'v-kv-val';
    applyFormat(kEl, node.columns?.[0]);     // todas as chaves
    applyFormat(valEl, node.columns?.[1]);   // todos os valores
    kEl.dataset.kvKey = valEl.dataset.kvKey = key;

    const kctx = { self: node, key, col: 0 }, vctx = { self: node, key, col: 1 };
    attachInlineEdit(kEl, {
      get: () => key,
      set: v => {
        if (v.trim() === key) return;
        if (!Model.renameKey(node.id, key, v)) return toast(t('kv.invalid'), t('kv.invalidMsg'));
        key = v.trim();
        kctx.key = vctx.key = key;
        kEl.dataset.kvKey = valEl.dataset.kvKey = key;
        persist();
      },
      placeholder: t('ph.key'),
    });
    renderRich(kEl, key, kctx);

    attachInlineEdit(valEl, { get: () => node.data[key] ?? '', set: v => { node.data[key] = v; persist(); }, placeholder: t('ph.value') });
    renderRich(valEl, node.data[key], vctx);

    grid.append(kEl, valEl);
  });

  el.append(label, grid);
  return el;
}

function buildTable(node) {
  if (!node.header?.length) node.header = [{ id: uuid(), data: [] }];
  node.rows ??= [];
  const header = node.header[0];
  header.data ??= [];

  const wrap  = document.createElement('div');
  const label = document.createElement('div');
  wrap.className  = 'v-table';
  label.className = 'v-table-label primary-field';
  editable(label, node, 'title', { nav: true, placeholder: t('ph.title') });

  const tw    = document.createElement('div');
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  tw.className    = 'v-table-wrap';
  table.className = 'gdd-table';
  table.dataset.tableId = node.id;

  // A navegação por TAB/setas entre células fica em startInlineEdit (tableNav)
  // Tipo de dado (15d): da coluna ou da tabela; célula fora do tipo ganha contorno vermelho fosco, sem travar
  const kindOf = ci => node.columns?.[ci]?.kind ?? node.dataKind ?? null;
  const mark = (cell, value, ci, row) => {
    const shown = cellShown(node, row, ci, value);   // célula com fórmula: vale o valor calculado (fase 17)
    const bad = cell.tagName === 'TD' && !cellValid(shown, kindOf(ci));
    cell.classList.toggle('cell-invalid', bad);
    if (bad) cell.title = t('valid.bad', { kind: t(`kind.${kindOf(ci)}`) }); else cell.removeAttribute('title');
  };
  const makeCell = (tag, rowObj, ci) => {
    rowObj.data ??= [];
    const cell = document.createElement(tag);
    cell.dataset.col = ci;
    applyFormat(cell, node.columns?.[ci]);   // a configuração vale para a coluna inteira
    attachInlineEdit(cell, {
      get: () => rowObj.data[ci] ?? '',
      set: v => { rowObj.data[ci] = v; mark(cell, v, ci, rowObj); persist(); },
    });
    renderRich(cell, rowObj.data[ci], { self: node, row: rowObj, col: ci });
    mark(cell, rowObj.data[ci], ci, rowObj);
    return cell;
  };

  // Sem alça de arrastar nas linhas: a tabela começa na coluna 1 (a ordem muda pelo menu da linha)
  const htr = vEl('tr', '', header);
  htr.dataset.rowId = header.id;
  header.data.forEach((_, ci) => htr.appendChild(makeCell('th', header, ci)));
  thead.appendChild(htr);

  node.rows.forEach(row => {
    const tr = vEl('tr', '', row);
    tr.dataset.rowId = row.id;
    header.data.forEach((_, ci) => tr.appendChild(makeCell('td', row, ci)));
    tbody.appendChild(tr);
  });

  table.append(thead, tbody);
  tw.appendChild(table);
  wrap.append(label, tw);
  return wrap;
}

// Sumário / cardápio (12a): linhas com duas colunas de uma linha; por padrão, a da direita fica à direita
const SUMMARY_ALIGN = ['left', 'right'];
function buildSummary(node) {
  node.rows ??= [];
  const el    = document.createElement('div');
  const label = document.createElement('div');
  const list  = document.createElement('div');
  el.className    = 'v-summary';
  label.className = 'v-summary-label primary-field';
  list.className  = 'v-sum-list';
  editable(label, node, 'title', { nav: true, placeholder: t('ph.title') });

  node.rows.forEach(row => {
    row.data ??= ['', ''];
    const r = document.createElement('div');
    r.className = 'v-sum-row';
    r.dataset.rowId = row.id;
    [0, 1].forEach(ci => {
      const c = document.createElement('div');
      c.className = `v-sum-cell v-sum-c${ci}`;
      c.dataset.sumCol = ci;
      c.style.textAlign = SUMMARY_ALIGN[ci];
      applyFormat(c, node.columns?.[ci]);   // o alinhamento configurado vale para a coluna inteira
      attachInlineEdit(c, { get: () => row.data[ci] ?? '', set: v => { row.data[ci] = v; persist(); }, placeholder: t(ci ? 'ph.value' : 'ph.text') });
      renderRich(c, row.data[ci], { self: node, row, col: ci });
      r.appendChild(c);
    });
    list.appendChild(r);
  });
  el.append(label, list);
  return el;
}

// Grid (12b): colunas (1 a 3, padrão 3), cada uma com a sua lista; sem cabeçalho. ⚙ escolhe as colunas.
function buildGridBody(node) {
  const grid = document.createElement('div');
  grid.className = 'v-grid';
  grid.style.setProperty('--cols', node.content.length);
  node.content.forEach(col => {
    const c = document.createElement('div');
    c.className = 'v-grid-col';
    c.dataset.parentId = col.id;
    (col.content || []).forEach(child => c.appendChild(buildNode(child)));
    if (!col.content?.length) c.appendChild(addItemButton(col.id, typesFor(blocks(), col)));
    grid.appendChild(c);
  });
  return grid;
}

function gridGear(node) {
  const btn = document.createElement('button');
  btn.className = 'v-grid-gear';
  btn.textContent = '⚙';
  btn.title = btn.ariaLabel = t('grid.settings');
  btn.addEventListener('click', e => {   // clique esquerdo abre as configurações do grid
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    showContextMenu(r.right - 160, r.bottom + 2, gridColumnsMenu(node));
  });
  return btn;
}

const gridColumnsMenu = node => radio(node.content.length, [1, 2, 3], n => t('grid.cols', { n }),
  n => structural(() => Model.setGridColumns(node.id, n), { op: 'CONFIGURAR_ITEM' }));

// Grid dentro do contêiner (como item)
function buildGrid(node) {
  const el = document.createElement('div');
  el.className = 'v-grid-wrap';
  el.append(gridGear(node), buildGridBody(node));
  return el;
}

// Grid fora dos contêineres: entre eles, com alça para arrastar e ⚙
function buildTopGrid(node) {
  const card = vEl('div', 'entry entry-grid', node);
  card.dataset.kind = 'grid';
  const handle = document.createElement('div');
  handle.className = 'entry-drag-handle drag-handle entry-grid-handle';
  handle.textContent = '⠿';
  handle.title = t('editor.drag');
  handle.addEventListener('pointerdown', e => dragContainer(e, card));
  card.append(handle, gridGear(node), buildGridBody(node));
  return card;
}

function buildChecklist(node) {
  node.items ??= [];
  const el    = document.createElement('div');
  const label = document.createElement('div');
  const list  = document.createElement('div');
  el.className    = 'v-checklist';
  label.className = 'v-checklist-label primary-field';
  list.className  = 'v-tasks';
  editable(label, node, 'title', { nav: true, placeholder: t('ph.title') });

  node.items.forEach(task => {
    const row  = document.createElement('div');
    const box  = document.createElement('input');
    const text = document.createElement('div');
    row.className = 'v-task' + (task.done ? ' done' : '');
    row.dataset.taskId = task.id;
    box.type = 'checkbox';
    box.checked = !!task.done;
    box.setAttribute('aria-label', t('check.toggle'));
    box.addEventListener('change', () => {
      task.done = box.checked;
      row.classList.toggle('done', task.done);
      persist();
    });
    text.className = 'v-task-text';
    editable(text, task, 'text', { placeholder: t('ph.task') });
    row.append(box, text);
    list.appendChild(row);
  });

  el.append(label, list);
  return el;
}

/* ============================================================
   DOCUMENTO: abrir, trocar, sincronizar
   ============================================================ */

function showEditor() {
  document.getElementById('editor-app').classList.add('visible');
  hideLoadScreen();
  renderEditor({ keepScroll: false, full: true });   // documento aberto: desenho completo, com a entrada dos cards
  checkMediaAccess();   // mídias ao lado de um JSON aberto sozinho: oferece dar acesso à pasta
}

function chooseEditorDocument(cancel = false) {
  return chooseDocument({ title: 'WizarD<span>.</span>', subtitle: t('ls.subtitle'), cancel, onReady: showEditor });
}

// Outra aba (ou o arquivo) mudou o documento → redesenha.
// Se um campo está em edição, espera terminar para não perder o que está sendo digitado.
let pendingRefresh = null;
function onDocChanged(rec, source) {
  if (source === 'closed') return chooseEditorDocument();          // o documento atual foi apagado e não sobrou nenhum
  renderDocStatus(document.getElementById('doc-status'));
  if (source === 'open') { showEditor(); Docs.checkFile(); return; } // outro documento foi aberto (gerenciador)
  if (source === 'local') return;
  if (document.querySelector('.cell-editing')) { pendingRefresh = source; return; }
  renderEditor();
  if (source === 'tab') toast(t('sync.updated'), t('sync.updatedMsg'));
}

/* ============================================================
   INIT
   ============================================================ */

/* ============================================================
   UNDO / REDO — Ctrl+Z · Ctrl+Y (ou Ctrl+Shift+Z) · botões ↶ ↷
   Dentro de um campo em edição, o Ctrl+Z é o do navegador (letra a letra).
   ============================================================ */

async function historyStep(dir) {
  if (!Docs.current) return;
  const op = dir < 0 ? await Timeline.undo() : await Timeline.redo();
  if (!op) return toast(t(dir < 0 ? 'history.nothingUndo' : 'history.nothingRedo'));
  renderEditor();
  updateHistoryButtons();
  // Parte pulada: aquele trecho foi mudado depois (ex.: em outra aba) e a mudança de lá foi mantida (16a)
  if (op.conflicts) toast(t('history.partial'), t('history.partialMsg', { n: op.conflicts }));
  else toast(t(dir < 0 ? 'history.undone' : 'history.redone'), t(`op.${op.type}`));
}

function updateHistoryButtons() {
  document.getElementById('btn-undo').disabled = !Timeline.canUndo;
  document.getElementById('btn-redo').disabled = !Timeline.canRedo;
}

document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  const dir = key === 'z' ? (e.shiftKey ? 1 : -1) : key === 'y' ? 1 : 0;
  if (!dir) return;
  if (e.target.closest?.('input, textarea') || document.querySelector('.cell-editing, .wz-modal')) return;
  e.preventDefault();
  historyStep(dir);
});

async function initEditor() {
  await loadPrefs();   // preferências (sinais da sidebar)
  applyI18n();
  initSidebarToggle();
  initSaveButton(document.getElementById('btn-save'));
  initLanguageButton(document.getElementById('btn-lang'));
  document.getElementById('btn-preview').addEventListener('click', openPreview);   // export.js
  document.getElementById('btn-docs').addEventListener('click', () => openDocManager());
  document.getElementById('btn-undo').addEventListener('click', () => historyStep(-1));
  document.getElementById('btn-redo').addEventListener('click', () => historyStep(+1));
  Presence.render();   // avatar do usuário e espaço dos colaboradores (presence.js)

  onContextAction(mainEl(), (x, y, target) => openMenu(x, y, target));
  mainEl().addEventListener('click', onSelectClick);        // seleção por clique (10b)
  initNavComments();                                        // hover no índice mostra o comentário (15e)
  document.getElementById('btn-settings')?.addEventListener('click', openSettings);
  document.getElementById('btn-guide')?.addEventListener('click', openGuide);   // 18d
  // ? (fora da edição) abre o guia rápido
  document.addEventListener('keydown', e => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea') || document.querySelector('.cell-editing, .wz-modal')) return;
    e.preventDefault();
    openGuide();
  });
  document.addEventListener('keydown', onSelectionKey);     // setas, Enter, Esc e Ctrl+Alt+letra
  initFileDrop();   // arrastar imagens e JSON para o documento
  Docs.onChange(onDocChanged);
  Docs.onChange(updateHistoryButtons);
  window.addEventListener('langchange', () => { if (Docs.current) renderEditor(); });

  // Voltou para a aba: confere se o arquivo mudou fora do Wizard
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Docs.current) Docs.checkFile(); });

  // ?exemplo (link da página de apresentação, 18g): abre o exemplo direto
  if (new URLSearchParams(location.search).has('exemplo')) {
    history.replaceState(null, '', location.pathname);
    try { await Docs.openExample(); showEditor(); return; }
    catch (err) { toast('⚠', err.message); }
  }

  // Recuperação: o último documento abre direto do IndexedDB, sem precisar do arquivo
  if (await Docs.restore()) {
    showEditor();
    Docs.checkFile();
    return;
  }
  chooseEditorDocument();
}

initEditor();
