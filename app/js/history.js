/* ============================================================
   history.js — Undo / Redo (Ctrl+Z / Ctrl+Y)

   Linha do tempo:  A → B → C → D        (ponteiro = "atual")
                            ↑
   · Uma operação é registrada quando o documento muda no IndexedDB (Docs.update).
   · Não guarda o documento inteiro: só os contêineres que mudaram (antes/depois),
     a ordem dos contêineres e o nome, se mudou.
   · Fica no banco separado "Wizard-history" (pensando na colaboração futura).
   · Limite de 200 operações (a mais antiga sai). Desfazer e editar descarta o "refazer".
   · Não sobrevive ao fechar o navegador nem ao trocar de documento.
   ============================================================ */

const HISTORY_LIMIT = 200;
const historyChannel = 'BroadcastChannel' in window ? new BroadcastChannel('wizard-history') : null;

const opsStore = {
  async tx(mode, fn) {
    const db = await openHistoryDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction('ops', mode);
      const req = fn(tx.objectStore('ops'));
      tx.oncomplete = () => res(req?.result ?? null);
      tx.onerror    = () => rej(tx.error);
    });
  },
  add:   op  => opsStore.tx('readwrite', s => s.add(op)),
  del:   seq => opsStore.tx('readwrite', s => s.delete(seq)),
  clear: ()  => opsStore.tx('readwrite', s => s.clear()),
  // Apaga as operações de um documento feitas por esta aba
  async clearDoc(docId) {
    const db = await openHistoryDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('ops', 'readwrite');
      const req = tx.objectStore('ops').index('docId').openCursor(IDBKeyRange.only(docId));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (cur.value.tab === TAB_ID) cur.delete();
        cur.continue();
      };
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
};

// Tira uma operação do banco (se ainda não foi gravada, apaga assim que a gravação terminar)
function dropOp(op) {
  if (op.seq != null) opsStore.del(op.seq).catch(() => {});
  else op.dropped = true;
}

// Foto compacta do documento: nome, ordem dos contêineres e o JSON de cada um
function snapshot(rec) {
  return {
    name: rec.name,
    order: rec.blocks.map(b => b.id),
    containers: new Map(rec.blocks.map(b => [b.id, JSON.stringify(b)])),
  };
}

function diffSnapshots(a, b) {
  const before = {}, after = {};
  if (a.name !== b.name) { before.name = a.name; after.name = b.name; }

  const ids = new Set([...a.containers.keys(), ...b.containers.keys()]);
  const changed = [...ids].filter(id => a.containers.get(id) !== b.containers.get(id));
  const orderChanged = a.order.join() !== b.order.join();

  if (changed.length || orderChanged) {
    before.order = a.order; after.order = b.order;
    before.containers = Object.fromEntries(changed.map(id => [id, a.containers.get(id) ?? null]));
    after.containers  = Object.fromEntries(changed.map(id => [id, b.containers.get(id) ?? null]));
  }
  return Object.keys(before).length ? { before, after } : null;
}

/* ── Aplicar uma operação: mesclagem nó a nó (16a) ─────────────────
   Desfazer/refazer não troca o contêiner inteiro: compara, nó a nó, o lado de onde a operação
   sai (from) com o lado para onde vai (to) e aplica só essas mudanças no documento atual.
   Se um desses nós mudou depois (ex.: em outra aba), ele é pulado — a outra edição fica — e
   a mudança conta como conflito. Sem edição de fora, o resultado é o mesmo de antes. */
const ROOT = '__root', STUB = '__stub';
const CHILD_KEYS = ['content', 'header', 'rows', 'items'];
const isChildList = v => Array.isArray(v) && v.every(c => c && typeof c === 'object' && c.id);

// O próprio nó, sem as listas de filhos (que são comparadas nó a nó)
function ownOf(n) {
  const o = {};
  for (const k of Object.keys(n)) if (!(CHILD_KEYS.includes(k) && isChildList(n[k]))) o[k] = n[k];
  return JSON.stringify(o);
}
function flatten(node, map = new Map(), parent = null, key = null) {
  map.set(node.id, { node, parent, key, own: node[STUB] ? null : ownOf(node) });
  if (!node[STUB]) for (const k of CHILD_KEYS) if (isChildList(node[k])) node[k].forEach(c => flatten(c, map, node.id, k));
  return map;
}

// Um lado da operação como árvore: raiz virtual com os contêineres; os que não mudaram viram "stub"
function sideTree(side) {
  return { id: ROOT, content: side.order.map(id => id in side.containers
    ? (side.containers[id] ? JSON.parse(side.containers[id]) : null)
    : { id, [STUB]: true }).filter(Boolean) };
}

// Posição de um nó na lista nova: logo depois do irmão anterior (em `to`) que já está em `list`
function insertAfterSibling(list, node, toList, id) {
  const i = toList.findIndex(n => n.id === id);
  for (let j = i - 1; j >= 0; j--) {
    const at = list.findIndex(n => n.id === toList[j].id);
    if (at >= 0) return list.splice(at + 1, 0, node);
  }
  list.unshift(node);
}

function mergeTree(curRoot, fromRoot, toRoot) {
  const F = flatten(fromRoot), T = flatten(toRoot), C = flatten(curRoot);
  const listOf = (M, e) => M.get(e.parent)?.node[e.key];
  let conflicts = 0;

  // 1. Movido para outra lista (outro tópico, contêiner, capítulo…)
  for (const [id, t] of T) {
    const f = F.get(id), c = C.get(id);
    if (!f || !c || !t.parent || (f.parent === t.parent && f.key === t.key)) continue;
    const dest = C.get(t.parent);
    if (c.parent !== f.parent || c.key !== f.key || !dest) { conflicts++; continue; }
    const src = listOf(C, c); src.splice(src.indexOf(c.node), 1);
    insertAfterSibling(dest.node[t.key] ??= [], c.node, T.get(t.parent).node[t.key], id);
    Object.assign(c, { parent: t.parent, key: t.key });
  }
  // 2. Mudou o próprio nó (texto, título, configuração…)
  for (const [id, t] of T) {
    const f = F.get(id), c = C.get(id);
    if (!f || !c || f.own === t.own || t.own === null) continue;
    if (c.own !== f.own) { conflicts++; continue; }
    // Troca o próprio nó e mantém as listas de filhos atuais, na mesma ordem de chaves do lado `to`
    const own = JSON.parse(t.own), kids = {};
    for (const k of CHILD_KEYS) if (isChildList(c.node[k])) kids[k] = c.node[k];
    for (const k of Object.keys(c.node)) delete c.node[k];
    for (const k of Object.keys(t.node)) if (k in kids) c.node[k] = kids[k]; else if (k in own) c.node[k] = own[k];
    Object.assign(c.node, kids);
  }
  // 3. Sai (só o topo de cada parte que sai; os filhos vão junto)
  for (const [id, f] of F) {
    if (T.has(id) || (f.parent && !T.has(f.parent) && F.has(f.parent) && f.parent !== ROOT)) continue;
    const c = C.get(id);
    if (!c) continue;
    if (c.own !== f.own && f.own !== null) { conflicts++; continue; }
    const list = listOf(C, c);
    if (list) list.splice(list.indexOf(c.node), 1);
  }
  // 4. Volta (o topo de cada parte que volta, com os filhos); nunca duplica um id que já existe
  const present = new Set(flatten(curRoot).keys());
  for (const [id, t] of T) {
    if (F.has(id) || (t.parent && !F.has(t.parent) && t.parent !== ROOT)) continue;
    const dest = C.get(t.parent);
    if (present.has(id) || !dest || t.own === null) { conflicts++; continue; }
    insertAfterSibling(dest.node[t.key] ??= [], structuredClone(t.node), T.get(t.parent).node[t.key], id);
  }
  // 5. Mudou só a ordem dentro da mesma lista (mover para cima/baixo, arrastar)
  for (const [pid, tp] of T) {
    for (const k of CHILD_KEYS) {
      const tl = tp.node[k], fl = F.get(pid)?.node[k], cl = C.get(pid)?.node[k];
      if (!isChildList(tl) || !isChildList(fl) || !Array.isArray(cl)) continue;
      const inAll = new Set(fl.map(n => n.id).filter(id => tl.some(n => n.id === id) && cl.some(n => n.id === id)));
      const orderT = tl.map(n => n.id).filter(id => inAll.has(id));
      const orderF = fl.map(n => n.id).filter(id => inAll.has(id));
      if (orderT.join() === orderF.join()) continue;
      const slots = cl.map((n, i) => inAll.has(n.id) ? i : -1).filter(i => i >= 0);
      if (slots.map(i => cl[i].id).join() !== orderF.join()) { conflicts++; continue; }
      const byId = new Map(cl.map(n => [n.id, n]));
      slots.forEach((slot, j) => { cl[slot] = byId.get(orderT[j]); });
    }
  }
  return conflicts;
}

// Aplica a operação indo de `from` (lado atual dela) para `to`: desfazer = after → before
function applySide(rec, from, to) {
  let conflicts = 0;
  if ('name' in to) {
    if (rec.name === from.name) rec.name = to.name; else conflicts++;
  }
  if (to.order) {
    const root = { id: ROOT, content: rec.blocks };
    conflicts += mergeTree(root, sideTree(from), sideTree(to));
    rec.blocks = root.content;
  }
  return conflicts;
}

const Timeline = {
  docId: null,
  baseline: null,     // foto do último estado registrado
  list: [],           // operações desta aba para o documento atual
  pointer: 0,         // quantas operações estão "aplicadas"
  _applying: false,

  get canUndo() { return this.pointer > 0; },
  get canRedo() { return this.pointer < this.list.length; },

  // Documento novo/trocado: começa uma linha do tempo vazia (e apaga a do documento anterior)
  reset(rec) {
    if (this.docId && this.docId !== rec?.id) opsStore.clearDoc(this.docId).catch(() => {});
    this.docId = rec?.id ?? null;
    this.baseline = rec ? snapshot(rec) : null;
    this.list = [];
    this.pointer = 0;
  },

  // Mudança que não deve virar operação (outra aba, arquivo, salvar…): só atualiza a foto
  rebase(rec) { this.baseline = snapshot(rec); },

  // Chamado por Docs.update depois de alterar o documento.
  // A linha do tempo (memória) é atualizada na hora; o banco é gravado em segundo plano,
  // para um Ctrl+Z logo em seguida nunca se atropelar com o registro.
  record(type, rec) {
    if (this._applying) return;
    if (rec.id !== this.docId) this.reset(rec);
    const next = snapshot(rec);
    const diff = diffSnapshots(this.baseline, next);
    this.baseline = next;
    if (!diff) return;

    // Editou depois de desfazer: o "refazer" a partir daqui é descartado
    this.list.splice(this.pointer).forEach(dropOp);

    const op = { docId: rec.id, tab: TAB_ID, type, at: Date.now(), ...diff };
    this.list.push(op);
    while (this.list.length > HISTORY_LIMIT) dropOp(this.list.shift());
    this.pointer = this.list.length;

    const { seq, dropped, ...stored } = op;
    opsStore.add(stored)
      .then(key => { op.seq = key; if (op.dropped) opsStore.del(key); })
      .catch(() => {});
  },

  // op.conflicts: quantas mudanças foram puladas porque o nó mudou depois (ex.: em outra aba)
  async undo() {
    if (!this.canUndo) return null;
    const op = this.list[--this.pointer];
    op.conflicts = await this._apply(op.after, op.before);
    return op;
  },

  async redo() {
    if (!this.canRedo) return null;
    const op = this.list[this.pointer++];
    op.conflicts = await this._apply(op.before, op.after);
    return op;
  },

  async _apply(from, to) {
    this._applying = true;
    let conflicts = 0;
    try {
      await Docs.update(rec => { conflicts = applySide(rec, from, to); }, { record: false });
      this.rebase(Docs.current);
    } finally {
      this._applying = false;
    }
    return conflicts;
  },
};

// Mantém a foto em dia quando o documento muda por fora (outra aba, arquivo, abrir/salvar)
Docs.onChange((rec, source) => {
  if (!rec) return;
  if (rec.id !== Timeline.docId) return Timeline.reset(rec);
  if (source !== 'local' || !Timeline._applying) {
    // commits locais de Docs.update já atualizaram a foto; os demais (salvar, importar) só re-sincronizam
    const same = Timeline.baseline && !diffSnapshots(Timeline.baseline, snapshot(rec));
    if (!same) Timeline.rebase(rec);
  }
});

// O histórico não sobrevive ao fechar o navegador: se esta é a única aba aberta, começa do zero
(function clearIfAlone() {
  if (!historyChannel) return opsStore.clear().catch(() => {});
  let alone = true;
  historyChannel.addEventListener('message', e => {
    if (e.data === 'ping') historyChannel.postMessage('pong');
    if (e.data === 'pong') alone = false;
  });
  historyChannel.postMessage('ping');
  setTimeout(() => { if (alone) opsStore.clear().catch(() => {}); }, 300);
})();
