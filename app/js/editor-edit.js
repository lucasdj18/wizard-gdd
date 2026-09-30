/* ============================================================
   editor-edit.js — edição inline e navegação entre campos, operações estruturais,
   arrastar (mouse e toque) e seleção com atalhos de criação.
   Parte do editor (editor.js); carregado antes dele.
   ============================================================ */

/* ============================================================
   EDIÇÃO INLINE
   ============================================================ */

function editable(el, node, field, { nav = false, multiline = false, placeholder = '' } = {}) {
  attachInlineEdit(el, {
    get: () => node[field] ?? '',
    set: v => { node[field] = v; persist(nav); },
    multiline, placeholder,
  });
  renderRich(el, node[field], { self: node });
}

function attachInlineEdit(el, opts) {
  el.classList.add('editable');
  if (opts.placeholder) el.dataset.placeholder = opts.placeholder;
  el._edit = opts;
  el.addEventListener('dblclick', e => {
    if (e.target.closest('.f-link')) return;
    e.stopPropagation();
    startInlineEdit(el);
  });
  // Toque duplo (em telas de toque o dblclick nem sempre chega)
  el.addEventListener('pointerup', e => {
    if (e.pointerType !== 'touch' || e.target.closest('.f-link')) return;
    const now = Date.now();
    if (now - (el._lastTap || 0) < 350) { el._lastTap = 0; startInlineEdit(el); }
    else el._lastTap = now;
  });
}

function startInlineEdit(el) {
  const opts = el?._edit;
  if (!opts || el.classList.contains('cell-editing')) return;

  const raw   = String(opts.get());
  const input = document.createElement(opts.multiline ? 'textarea' : 'input');
  input.className = 'inline-edit-input';
  input.value = raw;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.multiline) input.rows = Math.max(2, raw.split('\n').length);

  el.classList.add('cell-editing');
  el.innerHTML = '';
  el.appendChild(input);
  input.focus();
  input.select();
  Formula.attachPicker(input);   // `f{ abre a busca de alvos (17c); fica com as teclas enquanto está aberta

  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    if (save && input.value !== raw) opts.set(input.value);
    el.classList.remove('cell-editing');
    renderRich(el, opts.get());
    // Uma atualização de outra aba chegou durante a edição: aplica agora
    if (pendingRefresh) { const src = pendingRefresh; pendingRefresh = null; setTimeout(() => onDocChanged(Docs.current, src)); }
  };

  // Teclado tipo formulário:
  //   Enter → salva e vai para o próximo campo (numa célula: desce para a de baixo; da última linha, sai para
  //   o próximo item) · Shift+Enter → quebra de linha · Esc → cancela
  //   TAB/Shift+TAB → próximo/anterior (na tabela: anda pela linha e pula de linha)
  //   ↑ ↓ → campo anterior/seguinte, contínuo pelo documento (texto de várias linhas: só na primeira/última
  //   linha); na tabela, célula de cima/baixo · ← → na tabela: célula ao lado (na borda do texto) (3g)
  const inCell = el.matches('td[data-col], th[data-col]');
  const go = target => { finish(true); goToField(target); };
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {   // cancela e volta para a seleção do item (10b)
      e.preventDefault(); e.stopPropagation(); finish(false);
      const unit = el.closest('.v-node, .entry, .chapter');
      if (unit) select(unit.dataset.nodeId, { scroll: false });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(inCell ? tableNav(el, 'vertical', +1) : adjacentField(el, +1)); return; }
    if (e.key === 'Tab') { e.preventDefault(); go(inCell ? tableNav(el, 'tab', e.shiftKey ? -1 : 1) : adjacentField(el, e.shiftKey ? -1 : 1)); return; }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!inCell) {   // fora da tabela: ↑ ↓ andam pelos campos do documento
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (opts.multiline && !atLineEdge(input, dir)) return;   // dentro do texto, a seta anda entre as linhas
      const target = adjacentField(el, dir);
      if (target) { e.preventDefault(); go(target); }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); go(tableNav(el, 'vertical', e.key === 'ArrowUp' ? -1 : 1)); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (atTextEdge(input, dir)) { e.preventDefault(); go(tableNav(el, 'wrap', dir)); }
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// ── Navegação entre campos ────────────────────────────────────
const fieldList = () => [...mainEl().querySelectorAll('.editable')];

function goToField(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  startInlineEdit(el);
}

// Campo anterior/seguinte na ordem da página
function adjacentField(el, dir) {
  const list = fieldList();
  return list[list.indexOf(el) + dir] || null;
}

// Primeiro campo fora do item atual (item vizinho), na direção dir
function fieldOutsideItem(el, dir) {
  const node = el.closest('.v-node');
  const list = fieldList();
  for (let i = list.indexOf(el) + dir; i >= 0 && i < list.length; i += dir) {
    if (!node || !node.contains(list[i])) return list[i];
  }
  return null;
}

// Texto de várias linhas: o cursor está na primeira (dir -1) ou na última linha (dir +1)?
// Com tudo selecionado (o estado ao entrar no campo), vale como borda.
function atLineEdge(input, dir) {
  const { selectionStart: s, selectionEnd: e, value } = input;
  if (s === 0 && e === value.length) return true;
  return dir < 0 ? !value.slice(0, s).includes('\n') : !value.slice(e).includes('\n');
}

// Cursor na borda do texto (ou tudo selecionado, que é o estado ao entrar na célula)
function atTextEdge(input, dir) {
  const { selectionStart: s, selectionEnd: e, value } = input;
  if (s === 0 && e === value.length) return true;
  return dir > 0 ? s === value.length && e === value.length : s === 0 && e === 0;
}

// Grade da tabela (cabeçalho + linhas) e posição da célula
function tableNav(cell, mode, dir) {
  const rows = [...cell.closest('table').querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('[data-col]')]);
  const r = rows.findIndex(row => row.includes(cell));
  const c = rows[r].indexOf(cell);
  const row = rows[r];

  if (mode === 'wrap') return row[(c + dir + row.length) % row.length];            // → no fim volta ao início da linha
  if (mode === 'vertical') {
    const target = rows[r + dir];
    return target ? target[Math.min(c, target.length - 1)] : fieldOutsideItem(cell, dir); // sai para o item vizinho
  }
  // TAB: anda pela linha, pula de linha; no fim da tabela vai para o próximo item
  if (dir > 0) return row[c + 1] || rows[r + 1]?.[0] || fieldOutsideItem(cell, +1);
  return row[c - 1] || rows[r - 1]?.[rows[r - 1].length - 1] || adjacentField(cell, -1);
}

// Coloca em edição o campo principal de um nó recém-criado
function editNode(id) {
  if (MEDIA_TYPES().includes(findNode(blocks(), id)?.type)) return;   // mídia nova mostra o botão de escolher arquivo
  const el = document.querySelector(`[data-node-id="${CSS.escape(id)}"] .primary-field`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  startInlineEdit(el);
}

/* ============================================================
   OPERAÇÕES ESTRUTURAIS: alteram o modelo, gravam e redesenham
   ============================================================ */

async function structural(fn, { editNew = false, editKey = null, editTask = false, op = 'EDITAR_CAMPO' } = {}) {
  let result;
  try { result = fn(); }
  catch (err) { toast('⚠', err.message); renderEditor(); return; }   // recusado: a tela volta a ser o documento
  await Docs.update(null, { op });
  renderEditor();

  if (editNew && result?.id) { select(result.id, { scroll: false }); editNode(result.id); }   // o novo fica selecionado
  if (editKey) {   // par novo: edita a chave recém-criada
    const el = document.querySelector(`[data-node-id="${CSS.escape(editKey)}"] .v-kv-key[data-kv-key="${CSS.escape(result)}"]`);
    startInlineEdit(el);
  }
  if (editTask && result?.id) startInlineEdit(document.querySelector(`[data-task-id="${CSS.escape(result.id)}"] .v-task-text`));
}

// Edição de campo: grava no IndexedDB na hora (o arquivo só no Salvar).
// batchEdits: várias edições de uma vez (Substituir tudo) viram uma operação só, gravada por quem chamou.
let batchEdits = false;
function persist(nav = false) {
  if (batchEdits) return;
  if (nav) renderNavTree(document.getElementById('sidebar-nav'), blocks(), 'v-');
  refreshFormulas();
  schedulePagination();
  Docs.update().catch(err => { console.warn(err); toast(t('save.error'), err.message); });
}

/* ============================================================
   ARRASTAR (mouse e toque)
   ============================================================ */

// Nível de cima (contêiner, grid, capítulo); contêiner também entra e sai de capítulos
function dragContainer(e, card) {
  const main = mainEl();
  const node = findNode(blocks(), card.dataset.nodeId);
  const sel = ':scope > .entry, :scope > .chapter';
  const chapters = node.type === 'block' ? [...main.querySelectorAll('.chapter-body')] : [];
  startGhostDrag(e, card, {
    onMove: ev => {
      let zone = main;
      for (const z of chapters) {
        const r = z.getBoundingClientRect();
        if (ev.clientY >= r.top - 10 && ev.clientY <= r.bottom + 10) zone = z;
      }
      placeByY(zone, card, ev.clientY, sel);
    },
    onEnd: () => {
      const parent = card.parentElement;
      const index = [...parent.querySelectorAll(sel)].indexOf(card);
      const parentId = parent.classList.contains('chapter-body') ? parent.dataset.parentId : null;
      const loc = locate(blocks(), node.id);
      if ((loc.parent?.id ?? null) === parentId && loc.index === index) return;
      structural(() => Model.moveTo(node.id, parentId, index), { op: 'MOVER_BLOCO' });
    },
  });
}

// Itens: dentro do contêiner, entre contêineres, para dentro/fora de tópicos e das colunas do grid,
// só onde o tipo pode entrar (canPlace: níveis de tópico, grid só no contêiner…)
function dragItem(e, wrap) {
  const node = findNode(blocks(), wrap.dataset.nodeId);
  const allowed = [...mainEl().querySelectorAll('.entry-body, .v-topic-body, .v-grid-col')]
    .filter(c => !wrap.contains(c) && canPlace(blocks(), node, findNode(blocks(), c.dataset.parentId)));
  startGhostDrag(e, wrap, {
    onMove: ev => {
      let target = null;
      for (const c of allowed) {
        const r = c.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 14 && ev.clientY <= r.bottom + 14) target = c;
      }
      if (target) placeByY(target, wrap, ev.clientY, ':scope > .v-node');
    },
    onEnd: () => {
      const parent = wrap.parentElement;
      const index  = [...parent.querySelectorAll(':scope > .v-node')].indexOf(wrap);
      structural(() => Model.moveTo(wrap.dataset.nodeId, parent.dataset.parentId, index), { op: 'MOVER_BLOCO' });
    },
  });
}

/* ============================================================
   SELEÇÃO (10b) E ATALHOS DE CRIAÇÃO (10c)
   · Clique (ou toque) num item ou contêiner seleciona, sem editar.
   · ↑ ↓ andam pela seleção, na ordem da página · Enter edita · Esc sai.
   · Ctrl+Alt+letra cria logo depois do selecionado (CREATE_KEYS).
   ============================================================ */

let selectedId = null;
const selectables = () => [...mainEl().querySelectorAll('.chapter, .entry, .v-node')];
const unitEl = id => id ? mainEl().querySelector(`:is(.chapter, .entry, .v-node)[data-node-id="${CSS.escape(id)}"]`) : null;

function select(id, { scroll = true } = {}) {
  mainEl().querySelectorAll('.is-selected').forEach(el => el.classList.remove('is-selected'));
  const el = unitEl(id);
  selectedId = el ? id : null;
  if (!el) return;
  el.classList.add('is-selected');
  if (scroll) el.scrollIntoView({ block: 'nearest' });
}

// Clique fora de campos em edição, botões e links: seleciona o item (ou contêiner) mais de dentro
function onSelectClick(e) {
  if (e.target.closest('.cell-editing, .f-link, button, input, a, .wz-player, .wz-audio')) return;
  select(e.target.closest('.v-node, .entry, .chapter')?.dataset.nodeId ?? null, { scroll: false });
}

function editSelected() {
  const el = unitEl(selectedId);
  if (!el) return;
  const field = el.matches('.chapter') ? el.querySelector('.chapter-title')
    : el.matches('.entry') ? el.querySelector('.entry-title') : el.querySelector('.primary-field');
  if (field) startInlineEdit(field);
}

// Cria `type` logo depois do selecionado (contêiner selecionado: o item entra no fim dele)
function createAfterSelected(type) {
  const id = selectedId;
  const node = findNode(blocks(), id);
  if (!node) return;
  if (type === 'block' || type === 'chapter') {
    // Âncora: o próprio contêiner/capítulo/grid de fora; se for um item, o contêiner que o contém
    const topLevelGrid = node.type === 'grid' && !locate(blocks(), id).parent;
    const anchor = node.type === 'block' || node.type === 'chapter' || topLevelGrid
      ? id
      : ancestors(blocks(), id).find(a => a.type === 'block')?.id ?? id;
    return structural(() => type === 'block' ? Model.addContainer(anchor) : Model.addChapter(anchor), { editNew: true, op: 'CRIAR_BLOCO' });
  }
  const loc = locate(blocks(), id);
  structural(() => {
    if (node.type === 'block') return Model.addItem(type, { parentId: id });
    if (node.type === 'chapter') {   // capítulo selecionado: o item entra no último contêiner dele
      const last = node.content?.at(-1);
      if (!last) throw new Error(placeError(type));
      return Model.addItem(type, { parentId: last.id });
    }
    if (node.type === 'grid' && !loc.parent && type !== 'grid') return Model.addItem(type, { parentId: node.content[0].id });   // grid fora: 1ª coluna
    // Onde o tipo não pode ficar ao lado (tópico além de 4 níveis, grid dentro de grid): sobe até caber
    const probe = { type, content: [] };
    let after = id;
    for (let p = loc.parent; !canPlace(blocks(), probe, p); p = locate(blocks(), after).parent) {
      if (!p) throw new Error(placeError(type));
      after = p.id;
    }
    return Model.addItem(type, { afterId: after });
  }, { editNew: true, op: 'CRIAR_BLOCO' });
}

function onSelectionKey(e) {
  if (!selectedId || e.defaultPrevented || !Docs.current) return;
  if (document.querySelector('.cell-editing, .wz-modal, .wz-menu, .wz-bubble') || e.target.closest?.('input, textarea, select, [contenteditable]')) return;

  if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && /^Key[A-Z]$/.test(e.code)) {
    const type = Object.keys(CREATE_KEYS).find(k => CREATE_KEYS[k] === e.code.slice(3));
    if (!type) return;
    e.preventDefault();
    return createAfterSelected(type);
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const list = selectables();
    const next = list[list.findIndex(el => el.dataset.nodeId === selectedId) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) select(next.dataset.nodeId);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    editSelected();
  } else if (e.key === 'Escape') {
    select(null);
  }
}
