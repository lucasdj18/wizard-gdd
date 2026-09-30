/* ============================================================
   model.js — operações sobre o documento (sem tocar na tela)

   Contêiner = bloco de nível mais alto (type 'block').
   Item      = cada elemento dentro de um contêiner ou tópico.
   Todas as funções mexem em Docs.current.blocks; quem chama
   grava (Docs.update) e redesenha. Base para o Undo/Redo (fase 3).
   ============================================================ */

// ── Criar ─────────────────────────────────────────────────────
function newNode(type) {
  const id = uuid();
  const row = n => ({ id: uuid(), data: Array(n).fill('') });
  switch (type) {
    case 'block':       return { id, type, title: t('new.container'), content: [] };
    case 'topic':       return { id, type, title: t('new.topic'), content: [] };
    case 'description':
    case 'text':
    case 'obs':         return { id, type, content: '' };
    case 'item':        return { id, type, text: '' };
    case 'keyvalue':    return { id, type, title: t('new.keyvalue'), data: { [t('new.key')]: '' } };
    case 'table':       return { id, type, title: t('new.table'), header: [{ id: uuid(), data: [t('new.column', { n: 1 }), t('new.column', { n: 2 }), t('new.column', { n: 3 })] }], rows: [row(3), row(3)] };
    case 'checklist':   return { id, type, title: t('new.checklist'), items: [{ id: uuid(), text: '', done: false }] };
    case 'image':       return { id, type, src: '', caption: '' };
    case 'video':       return { id, type, src: '', caption: '' };
    case 'audio':       return { id, type, src: '', caption: '' };
    case 'divider':
    case 'spacer':      return { id, type };   // largura, desenho e altura só são gravados quando mudam
    case 'summary':     return { id, type, title: t('new.summary'), rows: [row(2), row(2)] };
    case 'grid':        return { id, type, content: [newNode('gridcol'), newNode('gridcol'), newNode('gridcol')] };
    case 'gridcol':     return { id, type, content: [] };
    case 'chapter':     return { id, type, title: t('new.chapter'), content: [newNode('block')] };
  }
  throw new Error(`Tipo desconhecido: ${type}`);
}

// Cópia profunda com IDs novos (duplicar)
// As fórmulas de dentro da cópia que apontam para algo da própria cópia passam a apontar para a cópia (17e);
// as que apontam para fora continuam iguais.
function cloneWithNewIds(node) {
  const copy = structuredClone(node);
  const ids = new Map();   // id antigo → novo
  walkNodes([copy], n => { const old = n.id; n.id = uuid(); if (old) ids.set(old, n.id); });
  eachText([copy], text => Formula.has(text) ? Formula.remap(text, ids) : undefined);
  return copy;
}

// ── Onde cada tipo pode entrar ────────────────────────────────
// Ancestrais de um nó (do mais próximo ao contêiner)
function ancestors(blocks, id) {
  const parent = new Map();
  walkNodes(blocks, (n, p) => { if (p && n.id) parent.set(n.id, p); });
  const out = [];
  for (let p = parent.get(id); p; p = parent.get(p.id)) out.push(p);
  return out;
}
// Nível do tópico: 1 = tópico direto no contêiner; conta o próprio nó se for tópico
const topicLevel = (blocks, node) => ancestors(blocks, node.id).filter(a => a.type === 'topic').length + (node.type === 'topic' ? 1 : 0);
// Níveis de tópico dentro de um nó (0 = nenhum)
const topicHeight = node => node.type === 'topic'
  ? 1 + Math.max(0, ...(node.content || []).map(topicHeight))
  : Math.max(0, ...(node.content || []).map(topicHeight));

// Pode `node` entrar em `parent`? parent null = nível de cima (só contêiner e grid)
function canPlace(blocks, node, parent) {
  if (!parent) return node.type === 'block' || node.type === 'grid' || node.type === 'chapter';
  if (parent.type === 'chapter') return node.type === 'block';                 // capítulo só aceita contêiner (15a)
  if (node.type === 'block' || node.type === 'gridcol' || node.type === 'chapter') return false;
  if (node.type === 'grid') return parent.type === 'block';                   // grid não entra em tópico nem em grid
  if (parent.type === 'grid') return false;                                    // no grid, só nas colunas
  const inTopic = parent.type === 'topic' ? topicLevel(blocks, parent) : ancestors(blocks, parent.id).filter(a => a.type === 'topic').length;
  return inTopic + topicHeight(node) <= MAX_TOPIC_DEPTH;
}
const placeError = type => t(type === 'topic' ? 'err.topicDepth' : type === 'grid' ? 'err.gridPlace' : 'err.place', { n: MAX_TOPIC_DEPTH });

// Tipos que podem ser adicionados dentro de `parent` (menu Adicionar)
const typesFor = (blocks, parent) => ITEM_TYPES.filter(type => canPlace(blocks, { type, content: [] }, parent));

// ── Localizar ─────────────────────────────────────────────────
// Devolve { list, index, parent } da lista que contém o nó (blocks, content, rows ou items)
function locate(blocks, id) {
  const search = (list, parent) => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { list, index: i, parent };
      for (const key of ['content', 'rows', 'items']) {
        if (Array.isArray(n[key])) {
          const found = search(n[key], n);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return search(blocks, null);
}

const Model = {
  get blocks() { return Docs.current.blocks; },

  // Contêineres
  // Contêiner logo depois de afterId: no nível de cima ou dentro do mesmo capítulo; sem afterId, no fim
  addContainer(afterId = null) {
    const node = newNode('block');
    const loc = afterId ? locate(this.blocks, afterId) : null;
    if (loc && (!loc.parent || loc.parent.type === 'chapter')) loc.list.splice(loc.index + 1, 0, node);
    else this.blocks.push(node);
    return node;
  },

  // Índice no nível de cima do elemento que contém afterId (para grid e capítulo, que só ficam lá)
  _topIndex(afterId) {
    return afterId ? this.blocks.findIndex(b => b.id === afterId || findNode([b], afterId)) : -1;
  },

  // Capítulo (15a) no nível de cima, com um contêiner dentro
  addChapter(afterId = null) {
    const node = newNode('chapter');
    const i = this._topIndex(afterId);
    this.blocks.splice(i === -1 ? this.blocks.length : i + 1, 0, node);
    return node;
  },

  // Item dentro de um contêiner/tópico (no fim) ou logo abaixo de outro item
  addItem(type, { parentId = null, afterId = null } = {}) {
    const node = newNode(type);
    if (afterId) {
      const loc = locate(this.blocks, afterId);
      if (!canPlace(this.blocks, node, loc.parent)) throw new Error(placeError(type));
      loc.list.splice(loc.index + 1, 0, node);
    } else {
      const parent = findNode(this.blocks, parentId);
      if (!canPlace(this.blocks, node, parent)) throw new Error(placeError(type));
      (parent.content ??= []).push(node);
    }
    return node;
  },

  // Grid fora dos contêineres (no nível de cima), logo depois de afterId
  addGrid(afterId = null) {
    const node = newNode('grid');
    const i = this._topIndex(afterId);   // grid não entra em capítulo: vai depois dele
    this.blocks.splice(i === -1 ? this.blocks.length : i + 1, 0, node);
    return node;
  },

  // 1, 2 ou 3 colunas; os itens das colunas que saem vão para a última que fica (nada se perde)
  setGridColumns(gridId, n) {
    const grid = findNode(this.blocks, gridId);
    const cols = grid.content;
    while (cols.length < n) cols.push(newNode('gridcol'));
    if (cols.length > n) {
      const removed = cols.splice(n);
      cols[n - 1].content.push(...removed.flatMap(c => c.content || []));
    }
  },

  duplicate(id) {
    const loc = locate(this.blocks, id);
    const copy = cloneWithNewIds(loc.list[loc.index]);
    loc.list.splice(loc.index + 1, 0, copy);
    return copy;
  },

  remove(id) {
    const loc = locate(this.blocks, id);
    return loc ? loc.list.splice(loc.index, 1)[0] : null;
  },

  // Sobe (-1) ou desce (+1) dentro da mesma lista
  move(id, dir) {
    const { list, index } = locate(this.blocks, id);
    const to = index + dir;
    if (to < 0 || to >= list.length) return false;
    [list[index], list[to]] = [list[to], list[index]];
    return true;
  },

  // Move para outra lista (arrastar): parentId null = lista de contêineres
  moveTo(id, parentId, index) {
    const parent = parentId ? findNode(this.blocks, parentId) : null;
    const moving = findNode(this.blocks, id);
    // Confere antes de tirar do lugar: não entra em si mesmo nem onde o tipo não é permitido
    if (parent && (parent === moving || findNode([moving], parentId))) throw new Error(placeError(moving.type));
    if (!canPlace(this.blocks, moving, parent)) throw new Error(placeError(moving.type));
    const node = this.remove(id);
    const list = parent ? (parent.content ??= []) : this.blocks;
    list.splice(Math.min(index, list.length), 0, node);
  },

  // ── Tabela ──
  addRow(tableId, atIndex) {   // tabela ou sumário (2 colunas)
    const table = findNode(this.blocks, tableId);
    const row = { id: uuid(), data: Array(table.header?.[0]?.data.length ?? 2).fill('') };
    table.rows.splice(atIndex ?? table.rows.length, 0, row);
    return row;
  },
  removeRow(tableId, rowId) {
    const table = findNode(this.blocks, tableId);
    table.rows = table.rows.filter(r => r.id !== rowId);
  },
  // Sobe (-1) ou desce (+1) uma linha (a tabela não tem alça de arrastar)
  moveRow(tableId, rowId, dir) {
    const rows = findNode(this.blocks, tableId).rows;
    const i = rows.findIndex(r => r.id === rowId), to = i + dir;
    if (i < 0 || to < 0 || to >= rows.length) return false;
    [rows[i], rows[to]] = [rows[to], rows[i]];
    return true;
  },
  addColumn(tableId, atIndex) {
    const table = findNode(this.blocks, tableId);
    const at = atIndex ?? table.header[0].data.length;
    table.header[0].data.splice(at, 0, t('new.column', { n: table.header[0].data.length + 1 }));
    table.rows.forEach(r => { (r.data ??= []).splice(at, 0, ''); });
    if (table.columns) table.columns.splice(at, 0, null);   // configuração das colunas acompanha
  },
  removeColumn(tableId, colIndex) {
    const table = findNode(this.blocks, tableId);
    if (table.header[0].data.length <= 1) throw new Error(t('err.lastColumn'));
    table.header[0].data.splice(colIndex, 1);
    table.rows.forEach(r => r.data?.splice(colIndex, 1));
    table.columns?.splice(colIndex, 1);
  },

  // ── Chave-valor (mantém a ordem das chaves) ──
  addPair(kvId, afterKey = null) {
    const kv = findNode(this.blocks, kvId);
    let key = t('new.key'), n = 2;
    while (key in kv.data) key = `${t('new.key')} ${n++}`;
    const entries = Object.entries(kv.data);
    const at = afterKey === null ? entries.length : entries.findIndex(([k]) => k === afterKey) + 1;
    entries.splice(at, 0, [key, '']);
    kv.data = Object.fromEntries(entries);
    return key;
  },
  removePair(kvId, key) {
    const kv = findNode(this.blocks, kvId);
    delete kv.data[key];
  },
  // Devolve false se a nova chave for vazia ou já existir
  renameKey(kvId, oldKey, newKey) {
    const kv = findNode(this.blocks, kvId);
    newKey = newKey.trim();
    if (!newKey || (newKey !== oldKey && newKey in kv.data)) return false;
    kv.data = Object.fromEntries(Object.entries(kv.data).map(([k, v]) => [k === oldKey ? newKey : k, v]));
    return true;
  },

  // ── Checklist ──
  addTask(checklistId, afterTaskId = null) {
    const list = findNode(this.blocks, checklistId);
    const task = { id: uuid(), text: '', done: false };
    const i = afterTaskId ? list.items.findIndex(x => x.id === afterTaskId) + 1 : list.items.length;
    list.items.splice(i, 0, task);
    return task;
  },
  removeTask(checklistId, taskId) {
    const list = findNode(this.blocks, checklistId);
    list.items = list.items.filter(x => x.id !== taskId);
  },
};
