/* ============================================================
   editor-menus.js — menus do clique direito / toque longo / botão ⋯,
   Configurar item e Formatar.
   Parte do editor (editor.js); carregado antes dele.
   ============================================================ */

/* ============================================================
   MENUS (clique direito / toque longo / botão ⋯)
   ============================================================ */

function openMenu(x, y, target) {
  const container = target.closest('.entry');
  if (!container) {   // título do capítulo (fora de qualquer contêiner)
    const ch = target.closest('.chapter');
    if (ch) showContextMenu(x, y, chapterMenu(ch));
    return;
  }
  const cell = target.closest('td[data-col], th[data-col]');
  const kv   = target.closest('[data-kv-key]');
  const task = target.closest('.v-task');
  const sum  = target.closest('.v-sum-cell');
  const gal  = target.closest('.v-gallery-cell');
  const node = target.closest('.v-node');
  const field = target.closest('.editable');

  if (gal && node)       return showContextMenu(x, y, galleryMenu(gal, node));
  if (cell && node)      return showContextMenu(x, y, cellMenu(cell, node));
  if (kv && node)        return showContextMenu(x, y, kvMenu(kv, node));
  if (task && node)      return showContextMenu(x, y, taskMenu(task, node));
  if (sum && node)       return showContextMenu(x, y, summaryMenu(sum, node));
  if (node)              return showContextMenu(x, y, itemMenu(node, field));
  showContextMenu(x, y, container.matches('.entry-grid') ? topGridMenu(container) : containerMenu(container));
}

const submenu = (label, items, x, y) => ({ label: `${label} ▸`, run: () => showContextMenu(x, y, items) });

// Em todos os menus: o exclusivo do tipo em cima, '-' (separador) e o comum a todos embaixo
function containerMenu(card) {
  const id = card.dataset.nodeId;
  const r  = card.querySelector('.entry-header').getBoundingClientRect();
  const [x, y] = [r.right - 220, r.bottom];
  return [
    submenu(t('menu.addItem'), typeMenu(type => structural(() => Model.addItem(type, { parentId: id }), { editNew: true, op: 'CRIAR_BLOCO' })), x, y),
    submenu(t('hl.menu'), highlightMenu(findNode(blocks(), id)), x, y),
    '-',
    { label: t('menu.editTitle'), run: () => startInlineEdit(card.querySelector('.entry-title')) },
    ...topLevelCommon(id, card.querySelector('.entry-title').textContent),
  ];
}

// Comum aos elementos do nível de cima (contêiner e grid fora dos contêineres)
function topLevelCommon(id, name) {
  return [
    commentEntry(findNode(blocks(), id)),
    { label: t('menu.addContainerBelow'), hint: `Ctrl+Alt+${CREATE_KEYS.block}`, run: () => structural(() => Model.addContainer(id), { editNew: true, op: 'CRIAR_BLOCO' }) },
    { label: t('menu.addGridBelow'), run: () => structural(() => Model.addGrid(id), { op: 'CRIAR_BLOCO' }) },
    { label: t('menu.addChapterBelow'), hint: `Ctrl+Alt+${CREATE_KEYS.chapter}`, run: () => structural(() => Model.addChapter(id), { editNew: true, op: 'CRIAR_BLOCO' }) },
    { label: t('menu.duplicate'), run: () => structural(() => Model.duplicate(id), { op: 'DUPLICAR_BLOCO' }) },
    { label: t('menu.moveUp'),    run: () => structural(() => Model.move(id, -1), { op: 'MOVER_BLOCO' }) },
    { label: t('menu.moveDown'),  run: () => structural(() => Model.move(id, +1), { op: 'MOVER_BLOCO' }) },
    { label: t('menu.copyId'),    run: () => copyText(id) },
    { label: t('menu.copyLink'),  run: () => copyText(`\`f{${id}}\``, null, t('copy.link')) },   // fórmula pronta (17c)
    { label: t('menu.delete'), danger: true, run: () => confirmDelete(id, name) },
  ];
}

function chapterMenu(el) {
  const id = el.dataset.nodeId;
  const ch = findNode(blocks(), id);
  return [
    { label: t('menu.addContainerInChapter'), run: () => structural(() => {
      const last = ch.content?.at(-1);
      return last ? Model.addContainer(last.id) : ((ch.content ??= []).push(newNode('block')), ch.content.at(-1));
    }, { editNew: true, op: 'CRIAR_BLOCO' }) },
    '-',
    { label: t('menu.editTitle'), run: () => startInlineEdit(el.querySelector('.chapter-title')) },
    ...topLevelCommon(id, ch.title || t('type.chapter')),
  ];
}

function topGridMenu(card) {
  const id = card.dataset.nodeId;
  const r  = card.getBoundingClientRect();
  return [
    submenu(t('grid.settings'), gridColumnsMenu(findNode(blocks(), id)), r.right - 220, r.top + 10),
    '-',
    ...topLevelCommon(id, t('type.grid')),
  ];
}

// Quadro da galeria: trocar ou tirar a imagem daquele quadro (exclusivo), depois o comum do item
function galleryMenu(cellEl, nodeEl) {
  const node = findNode(blocks(), nodeEl.dataset.nodeId);
  const slot = +cellEl.dataset.slot;
  const has  = !!slotMedia(node, slot).src;
  return itemMenu(nodeEl, null, [
    { label: t(has ? 'menu.replaceMedia.image' : 'media.choose.image'), run: async () => {
      const file = await pickMediaFile('image');
      if (file) setMediaFile(node, file, slot);
    } },
    has && { label: t('menu.removeImage'), danger: true, run: () => structural(() => {
      if (slot) node.more[slot - 1] = null;
      else { node.src = ''; delete node.width; delete node.height; }
    }, { op: 'REMOVER_IMAGEM' }) },
  ], { noMediaReplace: true });
}

// Linha do sumário: editar a célula, linhas e a coluna (exclusivo), depois o comum do item
function summaryMenu(cellEl, nodeEl) {
  const id   = nodeEl.dataset.nodeId;
  const node = findNode(blocks(), id);
  const rowId = cellEl.closest('.v-sum-row').dataset.rowId;
  const idx  = node.rows.findIndex(r => r.id === rowId);
  const ci   = +cellEl.dataset.sumCol;
  const r = cellEl.getBoundingClientRect(), [x0, y0] = [r.left, Math.min(r.bottom, innerHeight - 200)];
  return itemMenu(nodeEl, null, [
    { label: t('menu.edit'), run: () => startInlineEdit(cellEl) },
    { label: t('menu.rowAbove'), run: () => structural(() => Model.addRow(id, idx)) },
    { label: t('menu.rowBelow'), run: () => structural(() => Model.addRow(id, idx + 1)) },
    idx > 0 && { label: t('menu.rowUp'), run: () => structural(() => Model.moveRow(id, rowId, -1), { op: 'MOVER_BLOCO' }) },
    idx < node.rows.length - 1 && { label: t('menu.rowDown'), run: () => structural(() => Model.moveRow(id, rowId, +1), { op: 'MOVER_BLOCO' }) },
    { label: t('menu.rowDelete'), danger: true, run: () => structural(() => Model.removeRow(id, rowId)) },
    submenu(t(ci ? 'cfg.rightCol' : 'cfg.leftCol'), columnMenu(node, ci, x0, y0, SUMMARY_ALIGN[ci]), x0, y0),
  ]);
}

// `own`: operações de uma parte do item (célula, par, tarefa), que vão antes das exclusivas do tipo
function itemMenu(nodeEl, field, own = [], { noMediaReplace = false } = {}) {
  const id   = nodeEl.dataset.nodeId;
  const item = findNode(blocks(), id);
  const loc  = locate(blocks(), id);
  const r    = nodeEl.getBoundingClientRect();
  const [x, y] = [Math.max(8, r.left + 20), Math.min(r.top + 20, innerHeight - 300)];
  const editTarget = field || nodeEl.querySelector('.primary-field');
  return [
    ...own,
    !noMediaReplace && MEDIA_TYPES().includes(item.type) && { label: t(`menu.replaceMedia.${item.type}`), run: async () => {
      const file = await pickMediaFile(item.type);
      if (file) setMediaFile(item, file);
    } },
    item.type === 'topic' && submenu(t('menu.addInside'), typeMenu(type => structural(() => Model.addItem(type, { parentId: id }), { editNew: true, op: 'CRIAR_BLOCO' }), typesFor(blocks(), item)), x, y),
    // Áudio: visual (onda ou linha) e velocidade, direto no menu (14a)
    item.type === 'audio' && submenu(t('audio.look'), radio(item.look, [null, 'line'], v => t(`audio.${v || AUDIO_LOOKS[0]}`), v => setItemOption(item, 'look', v)), x, y),
    item.type === 'audio' && submenu(t('audio.speed'), radio(item.speed, [null, 1.5, 2], v => `${String(v || 1).replace('.', LANG === 'pt' ? ',' : '.')}×`, v => setItemOption(item, 'speed', v)), x, y),
    '-',
    { label: t('menu.edit'), run: () => startInlineEdit(editTarget) },
    submenu(t('menu.configure'), configureMenu(item, x, y), x, y),
    submenu(t('menu.format'), itemFormatMenu(item, x, y), x, y),
    commentEntry(item),
    submenu(t('menu.addBelow'), typeMenu(type => structural(() => Model.addItem(type, { afterId: id }), { editNew: true, op: 'CRIAR_BLOCO' }), typesFor(blocks(), loc.parent)), x, y),
    { label: t('menu.duplicate'), run: () => structural(() => Model.duplicate(id), { op: 'DUPLICAR_BLOCO' }) },
    { label: t('menu.moveUp'),    run: () => structural(() => Model.move(id, -1), { op: 'MOVER_BLOCO' }) },
    { label: t('menu.moveDown'),  run: () => structural(() => Model.move(id, +1), { op: 'MOVER_BLOCO' }) },
    { label: t('menu.copyId'),    run: () => copyText(id) },
    { label: t('menu.copyLink'),  run: () => copyText(`\`f{${id}}\``, null, t('copy.link')) },   // fórmula pronta (17c)
    { label: t('menu.delete'), danger: true, run: () => confirmDelete(id, TYPES[item.type].label) },
  ];
}

/* ── Configurar e Formatar ──────────────────────────────────── */
// Opção dentro de um objeto de opções (item.format, item.columns[i]); null volta ao padrão e não é gravado
function setOption(owner, key, prop, value) {
  const opts = owner[key] ?? {};
  if (value == null) delete opts[prop]; else opts[prop] = value;
  if (Object.keys(opts).length) owner[key] = opts;
  else if (Array.isArray(owner)) owner[key] = null;
  else delete owner[key];
}
function setColumnOption(node, ci, prop, value) {
  node.columns ??= [];
  setOption(node.columns, ci, prop, value);
  if (!node.columns.some(Boolean)) delete node.columns;
}

// Lista de escolha única: ● no valor atual (null = padrão)
const radio = (current, values, labelOf, pick) =>
  values.map(v => ({ label: `${(current ?? null) === v ? '●' : '○'} ${labelOf(v)}`, run: () => pick(v) }));

// Formatar: cor, tamanho e fonte. `set(prop, valor)`; set(null) limpa os três
function formatMenu(fmt, set, x, y) {
  fmt ??= {};
  return [
    submenu(t('fmt.color'), radio(fmt.color, [null, ...Object.keys(FORMAT_COLORS)], v => t(v ? `color.${v}` : 'fmt.default'), v => set('color', v)), x, y),
    submenu(t('fmt.size'),  radio(fmt.size, ['sm', null, 'lg', 'xl'], v => t(v ? `size.${v}` : 'fmt.default'), v => set('size', v)), x, y),
    submenu(t('fmt.font'),  radio(fmt.font, [null, ...Object.keys(FORMAT_FONTS)], v => t(v ? `font.${v}` : 'fmt.default'), v => set('font', v)), x, y),
    (fmt.color || fmt.size || fmt.font) && '-',
    (fmt.color || fmt.size || fmt.font) && { label: t('fmt.clear'), run: () => set(null) },
  ];
}
const FORMAT_PROPS = ['color', 'size', 'font'];

function itemFormatMenu(item, x, y) {
  return formatMenu(item.format, (prop, v) => structural(() => {
    (prop ? [prop] : FORMAT_PROPS).forEach(p => setOption(item, 'format', p, prop ? v : null));
  }, { op: 'FORMATAR_ITEM' }), x, y);
}

// Configurar uma coluna (tabela, chave-valor, sumário): vale para a coluna inteira. def = alinhamento padrão
function columnMenu(node, ci, x, y, def = 'left') {
  const col = node.columns?.[ci] ?? {};
  const set = (prop, v) => structural(() => {
    (prop ? [prop] : FORMAT_PROPS).forEach(p => setColumnOption(node, ci, p, prop ? v : null));
  }, { op: 'FORMATAR_ITEM' });
  return [
    submenu(t('cfg.align'), radio(col.align, ALIGNS.map(a => a === def ? null : a), v => t(`align.${v || def}`), v => set('align', v)), x, y),
    submenu(t('menu.format'), formatMenu(col, set, x, y), x, y),
    node.type === 'table' && submenu(t('cfg.kind'), radio(col.kind, [null, ...Object.keys(DATA_KINDS)], v => t(`kind.${v || 'any'}`), v => set('kind', v)), x, y),
  ];
}

// Opção direta do item (null = padrão, que não é gravado)
const setItemOption = (item, prop, v) => structural(() => { if (v == null) delete item[prop]; else item[prop] = v; }, { op: 'CONFIGURAR_ITEM' });

// Configurar item: as opções próprias do tipo em cima; o contorno (comum a todos) embaixo
function configureMenu(item, x = 40, y = 40) {
  const cfg = (prop, v) => setItemOption(item, prop, v);
  const own = [];
  if (item.type === 'image') {   // galeria (14b): linhas × colunas; 1 × 1 é a imagem única de sempre
    const g = item.gallery || { rows: 1, cols: 1 };
    const setG = (prop, v) => structural(() => {
      const ng = { ...g, [prop]: v };
      if (ng.rows * ng.cols === 1) delete item.gallery; else item.gallery = ng;
    }, { op: 'CONFIGURAR_ITEM' });
    own.push(submenu(t('cfg.gallery'), [
      submenu(t('cfg.rows'), radio(g.rows, [1, 2, 3, 4], String, v => setG('rows', v)), x, y),
      submenu(t('cfg.cols'), radio(g.cols, [1, 2, 3, 4], String, v => setG('cols', v)), x, y),
    ], x, y));
  }
  if (item.type === 'divider') {
    own.push(submenu(t('cfg.width'), radio(item.width, DIVIDER_WIDTHS.map(w => w === DIVIDER_WIDTHS[0] ? null : w), v => `${v || DIVIDER_WIDTHS[0]}%`, v => cfg('width', v)), x, y));
    own.push(submenu(t('cfg.style'), radio(item.style, DIVIDER_STYLES.map(s => s === DIVIDER_STYLES[0] ? null : s), v => t(`style.${v || DIVIDER_STYLES[0]}`), v => cfg('style', v)), x, y));
  }
  if (item.type === 'spacer') {
    own.push(submenu(t('cfg.height'), radio(item.size, ['sm', null, 'lg', 'xl'], v => t(`space.${v || 'md'}`), v => cfg('size', v)), x, y));
  }
  if (MEDIA_TYPES().includes(item.type)) {
    own.push(submenu(t('cfg.fit'),   radio(item.fit, [null, 'cover', 'fill', 'none'], v => t(`fit.${v || 'contain'}`), v => cfg('fit', v)), x, y));
    own.push(submenu(t('cfg.align'), radio(item.align, ['left', null, 'right'], v => t(`align.${v || 'center'}`), v => cfg('align', v)), x, y));
  }
  if (item.type === 'keyvalue') {
    own.push(submenu(t('cfg.keys'),   columnMenu(item, 0, x, y), x, y));
    own.push(submenu(t('cfg.values'), columnMenu(item, 1, x, y), x, y));
  }
  if (item.type === 'summary') {
    own.push(submenu(t('cfg.leftCol'),  columnMenu(item, 0, x, y, SUMMARY_ALIGN[0]), x, y));
    own.push(submenu(t('cfg.rightCol'), columnMenu(item, 1, x, y, SUMMARY_ALIGN[1]), x, y));
  }
  if (item.type === 'grid') own.push(submenu(t('grid.settings'), gridColumnsMenu(item), x, y));
  if (item.type === 'table') {
    own.push(submenu(t('cfg.kindAll'), radio(item.dataKind, [null, ...Object.keys(DATA_KINDS)], v => t(`kind.${v || 'any'}`), v => cfg('dataKind', v)), x, y));
    (item.header?.[0]?.data || []).forEach((name, ci) =>
      own.push(submenu(`${t('menu.configColumn')}: ${plainText(name, blocks()) || '#' + (ci + 1)}`, columnMenu(item, ci, x, y), x, y)));
  }
  if (!own.length) own.push({ label: t('cfg.none'), disabled: true });
  return [
    ...own,
    '-',
    submenu(t('hl.menu'), highlightMenu(item), x, y),
    { label: `${hasBorder(item) ? '☑' : '☐'} ${t('menu.border')}`,
      run: () => structural(() => {
        const on = !hasBorder(item);
        if (on === (item.type === 'table')) delete item.border; else item.border = on;   // o padrão não é gravado
      }, { op: 'CONFIGURAR_ITEM' }) },
  ];
}

function cellMenu(cell, nodeEl) {
  const tableId = nodeEl.dataset.nodeId;
  const table   = findNode(blocks(), tableId);
  const tr      = cell.closest('tr');
  const isHead  = cell.tagName === 'TH';
  const col     = +cell.dataset.col;
  const rowId   = tr.dataset.rowId;
  const rowIdx  = isHead ? -1 : table.rows.findIndex(r => r.id === rowId);
  const cr = cell.getBoundingClientRect(), [x0, y0] = [cr.left, Math.min(cr.bottom, innerHeight - 200)];
  return itemMenu(nodeEl, null, [
    { label: t('menu.editCell'), run: () => startInlineEdit(cell) },
    !isHead && { label: t('menu.rowAbove'), run: () => structural(() => Model.addRow(tableId, rowIdx)) },
    { label: t('menu.rowBelow'), run: () => structural(() => Model.addRow(tableId, rowIdx + 1)) },
    !isHead && rowIdx > 0 && { label: t('menu.rowUp'), run: () => structural(() => Model.moveRow(tableId, rowId, -1), { op: 'MOVER_BLOCO' }) },
    !isHead && rowIdx < table.rows.length - 1 && { label: t('menu.rowDown'), run: () => structural(() => Model.moveRow(tableId, rowId, +1), { op: 'MOVER_BLOCO' }) },
    !isHead && { label: t('menu.rowDelete'), danger: true, run: () => structural(() => Model.removeRow(tableId, rowId)) },
    { label: t('menu.colLeft'),  run: () => structural(() => Model.addColumn(tableId, col)) },
    { label: t('menu.colRight'), run: () => structural(() => Model.addColumn(tableId, col + 1)) },
    { label: t('menu.colDelete'), danger: true, run: () => structural(() => Model.removeColumn(tableId, col)) },
    submenu(t('menu.configColumn'), columnMenu(table, col, x0, y0), x0, y0),
    { label: t('menu.copyRowId'), run: () => copyText(rowId) },
  ]);
}

function kvMenu(kvEl, nodeEl) {
  const kvId = nodeEl.dataset.nodeId;
  const key  = kvEl.dataset.kvKey;
  const [keyEl, valEl] = nodeEl.querySelectorAll(`[data-kv-key="${CSS.escape(key)}"]`);
  const ci = kvEl.classList.contains('v-kv-key') ? 0 : 1;   // configurar a chave configura todas as chaves
  const r = kvEl.getBoundingClientRect(), [x0, y0] = [r.left, Math.min(r.bottom, innerHeight - 200)];
  return itemMenu(nodeEl, null, [
    { label: t('menu.editKey'),   run: () => startInlineEdit(keyEl) },
    { label: t('menu.editValue'), run: () => startInlineEdit(valEl) },
    { label: t('menu.pairBelow'), run: () => structural(() => Model.addPair(kvId, key), { editKey: kvId }) },
    { label: t('menu.pairDelete'), danger: true, run: () => structural(() => Model.removePair(kvId, key)) },
    submenu(t(ci ? 'cfg.values' : 'cfg.keys'), columnMenu(findNode(blocks(), kvId), ci, x0, y0), x0, y0),
  ]);
}

function taskMenu(taskEl, nodeEl) {
  const listId = nodeEl.dataset.nodeId;
  const taskId = taskEl.dataset.taskId;
  return itemMenu(nodeEl, null, [
    { label: t('menu.editTask'),   run: () => startInlineEdit(taskEl.querySelector('.v-task-text')) },
    { label: t('menu.taskBelow'),  run: () => structural(() => Model.addTask(listId, taskId), { editTask: true }) },
    { label: t('menu.taskDelete'), danger: true, run: () => structural(() => Model.removeTask(listId, taskId)) },
  ]);
}

async function confirmDelete(id, name) {
  const node = findNode(blocks(), id);
  const cited = node ? citationsOf(blocks(), node) : 0;   // fórmulas de fora que vão quebrar (17f)
  const choice = await askChoice({
    title: t('delete.title'),
    message: t('delete.msg', { name: name || '—' }) + (cited ? ' ' + t('delete.cited', { n: cited }) : ''),
    options: [
      { value: 'delete', label: t('menu.delete'), danger: true },
      { value: 'cancel', label: t('action.cancel'), primary: true },
    ],
  });
  const type = findNode(blocks(), id)?.type;
  const op = MEDIA_TYPES().includes(type) ? mediaOp(type, 'REMOVER') : 'EXCLUIR_BLOCO';
  if (choice === 'delete') structural(() => Model.remove(id), { op });
}
