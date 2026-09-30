/* ============================================================
   docs.js — documentos: IndexedDB como fonte da verdade

   Registro de documento (store "documents"):
   { id, name, createdAt, modifiedAt, blocks,
     state:      'saved' | 'dirty'            → há alterações não gravadas no arquivo?
     permission: 'readwrite' | 'read' | 'none' → arquivo ligado e permissão ('none' = sem arquivo)
     fileHandle, fileName,                     → referência ao arquivo externo
     savedText,                                → conteúdo do arquivo na última sincronização
     rev, writer,                              → versão local e aba que gravou (sincronização)
     export: {} }                              → informações de exportação (fase 5)

   Toda edição → IndexedDB na hora. O arquivo só muda no Salvar.
   ============================================================ */

const KEY_CURRENT = 'current-doc';
const TAB_ID      = uuid();
const docsChannel = 'BroadcastChannel' in window ? new BroadcastChannel('wizard-docs') : null;

const docStore = {
  get: id  => idbTx('readonly',  s => s.get(id),    DOCS_STORE),
  put: rec => idbTx('readwrite', s => s.put(rec),   DOCS_STORE),
  all: ()  => idbTx('readonly',  s => s.getAll(),   DOCS_STORE),
  del: id  => idbTx('readwrite', s => s.delete(id), DOCS_STORE),
};

// Banco separado para o histórico (Undo/Redo, fase 3). Criado aqui para já existir.
let _historyDB = null;
function openHistoryDB() {
  _historyDB ??= new Promise((res, rej) => {
    const req = indexedDB.open('Wizard-history', 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
      store.createIndex('docId', 'docId');
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
  return _historyDB;
}

const Docs = {
  current: null,
  _listeners: new Set(),

  get supported() { return 'showOpenFilePicker' in window; },
  get dirty()     { return this.current?.state === 'dirty'; },
  get readOnly()  { return this.current?.permission === 'read'; },

  // fn(registro, origem) · origem: 'local' | 'tab' (outra aba) | 'file' (arquivo mudou fora)
  onChange(fn) { this._listeners.add(fn); },
  _emit(source) { this._listeners.forEach(fn => fn(this.current, source)); },

  _record(doc, { fileHandle = null, permission = 'none', savedText = null, state, dirHandle = null } = {}) {
    return {
      id: doc.id, name: doc.name, createdAt: doc.createdAt, modifiedAt: doc.modifiedAt, blocks: doc.blocks,
      state: state ?? (fileHandle ? 'saved' : 'dirty'),
      permission, fileHandle, fileName: fileHandle?.name ?? null, savedText,
      dirHandle,                                // pasta do projeto (JSON + mídias), quando conhecida
      rev: 0, writer: TAB_ID, export: {},
    };
  },

  async _commit(source = 'local') {
    const rec = this.current;
    rec.rev++;
    rec.writer = TAB_ID;
    await docStore.put(rec);
    await idbSave(KEY_CURRENT, rec.id);
    docsChannel?.postMessage({ type: 'doc', id: rec.id, rev: rec.rev, writer: TAB_ID });
    this._emit(source);
  },

  async _setCurrent(rec, source = 'local') {
    if (rec && this.current?.id === rec.id && rec !== this.current) keepSameNodes(this.current, rec);
    this.current = rec;
    await this._commit(source);
  },

  // ── Recuperação: reabre o último documento direto do IndexedDB (1f) ──
  async restore() {
    try {
      const id  = await idbLoad(KEY_CURRENT);
      const rec = id ? await docStore.get(id) : null;
      if (rec) { this.current = rec; this._emit('local'); }
      return rec;
    } catch (err) {
      console.warn('restore:', err);
      return null;
    }
  },

  // Confirma que o documento atual está gravado no IndexedDB antes de trocar de documento (10a).
  // Se a última versão ainda não chegou ao banco, grava de novo. false = não deu para gravar.
  async ensureStored() {
    const rec = this.current;
    if (!rec) return true;
    try {
      if ((await docStore.get(rec.id))?.rev === rec.rev) return true;
      await this._commit('local');
      return (await docStore.get(rec.id))?.rev === rec.rev;
    } catch (err) {
      console.warn('ensureStored:', err);
      return false;
    }
  },

  async createNew() {
    const now = new Date().toISOString();
    await this._setCurrent(this._record({ id: uuid(), name: t('doc.defaultName'), createdAt: now, modifiedAt: now, blocks: [] }));
    return this.current;
  },

  // Novo documento com a estrutura de um GDD e textos-guia (18b, modelo.js), no idioma atual
  async createFromTemplate() {
    const now = new Date().toISOString();
    await this._setCurrent(this._record({ id: uuid(), name: t('tpl.name'), createdAt: now, modifiedAt: now, blocks: buildGddTemplate() }));
    return this.current;
  },

  // "Ver um exemplo" (18c): o Farol de exemplos/ entra como documento no navegador, com as mídias copiadas
  // para o armazenamento do navegador (não depende de pasta). Aberto de novo, é o mesmo documento.
  EXAMPLE: 'Farol — exemplo de GDD.json',
  async openExample() {
    // exemplos/ fica ao lado de js/ (no app, nos testes e no site publicado)
    const base = new URL('../exemplos/', document.querySelector('script[src*="js/docs.js"]')?.src || location.href);
    const url = name => new URL(encodeURIComponent(name), base).href;
    let raw;
    try {
      const res = await fetch(url(this.EXAMPLE));
      if (!res.ok) throw new Error(res.status);
      raw = await res.text();
    } catch { throw new Error(t('example.unavailable')); }   // ex.: aberto direto do disco (file://)
    const { doc } = parseWizardText(raw, 'exemplo.json');
    const now = new Date().toISOString();
    const rec = (await docStore.get(doc.id)) || this._record({ ...doc, createdAt: doc.createdAt || now, modifiedAt: now });
    rec.example = true;   // o exemplo não tem pasta: nunca pede acesso a uma
    await this._exampleMedia(rec, url);
    await this._setCurrent(rec);   // quem chamou mostra o editor (como no Novo documento)
    return rec;
  },

  // Copia para o navegador as mídias do exemplo que ainda não estão lá (3 tentativas cada; reabrir completa)
  async _exampleMedia(rec, url) {
    if (typeof Media === 'undefined') return;
    let failed = 0;
    try {
      const dir = await Media._dir(rec.id);
      for (const name of Media.usedNames(rec)) {
        if (await Media.file({ id: rec.id }, `./${name}`)) continue;
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const res = await fetch(url(name));
            if (res.ok) { await writeFile(await dir.getFileHandle(name, { create: true }), await res.blob()); ok = true; }
          } catch (err) { console.warn(`Wizard: mídia do exemplo "${name}" (tentativa ${attempt + 1})`, err); }
          if (!ok) await new Promise(r => setTimeout(r, 300));
        }
        if (!ok) failed++;
      }
    } catch (err) { console.warn('Wizard: mídias do exemplo', err); failed = -1; }   // sem armazenamento: abre sem as mídias
    if (failed) toast(t('example.mediaMissing'), t('example.mediaMissingMsg'));
  },

  // ── Abrir ────────────────────────────────────────────────────
  // Precisa ser chamado num clique: o seletor dá leitura; a gravação é pedida logo em seguida
  async openFile() {
    const [fh] = await window.showOpenFilePicker({ types: JSON_TYPES });
    const granted = (await fh.requestPermission({ mode: 'readwrite' })) === 'granted';
    return this.openHandle(fh, granted ? 'readwrite' : 'read');
  },

  // Arquivo lembrado pela versão anterior do app (antes da fase 1)
  async legacyHandle() {
    try { return (await idbLoad(KEY_FILE)) || null; } catch { return null; }
  },

  async reconnectLegacy(fh) {
    const perm = await fh.requestPermission({ mode: 'readwrite' });
    if (perm === 'denied') throw new Error(t('open.deniedMsg'));
    const rec = await this.openHandle(fh, perm === 'granted' ? 'readwrite' : 'read');
    await idbDelete(KEY_FILE);
    return rec;
  },

  // Sem File System Access API: lê o arquivo escolhido num <input type=file>
  async openFileObject(file) {
    return this._import(await file.text(), file.name, null, 'none');
  },

  async openHandle(fh, permission) {
    return this._import(await (await fh.getFile()).text(), fh.name, fh, permission);
  },

  async _import(raw, fileName, fh, permission) {
    const parsed = parseWizardText(raw, fileName);   // lança WizardFormatError se inválido
    const { doc, fromVersion, fixedIds } = parsed;
    const changedByImport = fromVersion !== null || fixedIds > 0;

    // Já existe no navegador? (mesmo id no arquivo v1, ou o mesmo arquivo ligado)
    let existing = await docStore.get(doc.id);
    if (!existing && fh) existing = await this._findByHandle(fh);

    if (existing) {
      await this._resolveWithExisting(existing, parsed, raw, fh, permission);
    } else {
      await this._setCurrent(this._record(doc, {
        fileHandle: fh, permission, savedText: raw,
        state: fh && !changedByImport ? 'saved' : 'dirty',
      }));
    }

    if (fromVersion !== null) toast(t('open.migrated'), t('open.migratedMsg', { from: fromVersion, to: FORMAT_MAJOR }));
    if (fixedIds) toast(t('open.fixedIds'), t('open.fixedIdsMsg', { n: fixedIds }));
    if (permission === 'read') toast(t('open.readOnly'), t('open.readOnlyMsg'));
    return this.current;
  },

  async _findByHandle(fh) {
    for (const rec of await docStore.all()) {
      try { if (rec.fileHandle && await rec.fileHandle.isSameEntry(fh)) return rec; } catch { /* handle antigo */ }
    }
    return null;
  },

  // O documento já está no navegador: decide qual versão vale (1f)
  async _resolveWithExisting(existing, { doc }, raw, fh, permission) {
    const link = rec => Object.assign(rec, { fileHandle: fh ?? rec.fileHandle, fileName: fh?.name ?? rec.fileName, permission: fh ? permission : rec.permission });
    const fromFile = rec => Object.assign(rec, { name: doc.name, blocks: doc.blocks, modifiedAt: doc.modifiedAt, savedText: raw, state: fh ? 'saved' : 'dirty' });

    // Arquivo igual ao da última sincronização → a versão do navegador é a mais nova
    if (raw === existing.savedText) return this._setCurrent(link(existing));

    // Sem alterações locais pendentes → atualiza com o arquivo, sem perguntar
    if (existing.state !== 'dirty') return this._setCurrent(fromFile(link(existing)));

    const choice = await askChoice({
      title: t('conflict.title'),
      message: t('conflict.openMsg', { file: fh?.name ?? existing.fileName ?? '' }),
      options: [
        { value: 'file',  label: t('conflict.useFile'), danger: true },
        { value: 'new',   label: t('conflict.newDoc') },
        { value: 'local', label: t('conflict.keepLocal'), primary: true },
      ],
    });
    if (choice === 'file') return this._setCurrent(fromFile(link(existing)));
    if (choice === 'local') return this._setCurrent(link(existing));

    // Documento novo com a versão do arquivo; o do navegador fica intacto, mas desligado do arquivo
    Object.assign(existing, { fileHandle: null, fileName: null, permission: 'none', state: 'dirty' });
    await docStore.put(existing);
    const copy = this._record({ ...doc, id: uuid() }, { fileHandle: fh, permission, savedText: raw, state: fh ? 'saved' : 'dirty' });
    return this._setCurrent(copy);
  },

  // ── Gerenciador de documentos (fase 4) ─────────────────────
  // Todos os documentos do navegador, do mais recente para o mais antigo
  async list() {
    return (await docStore.all()).sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  },

  async open(id) {
    const rec = await docStore.get(id);
    if (!rec) throw new Error(t('docs.notFound'));
    await this._setCurrent(rec, 'open');
    return rec;
  },

  async rename(id, name) {
    name = name.trim() || t('doc.defaultName');
    if (id === this.current?.id) return this.update(rec => { rec.name = name; }, { op: 'ALTERAR_NOME' });
    const rec = await docStore.get(id);
    Object.assign(rec, { name, modifiedAt: new Date().toISOString(), state: 'dirty' });
    await docStore.put(rec);
  },

  async download(id) {
    const rec = id === this.current?.id ? this.current : await docStore.get(id);
    downloadText(serializeDocument(rec), `${safeFileName(rec.name)}.json`);
  },

  // Apaga do navegador (o arquivo no disco não é tocado). Se era o atual, abre o mais recente.
  async remove(id) {
    await docStore.del(id);
    if (typeof opsStore !== 'undefined') opsStore.clearDoc(id).catch(() => {});
    if (id !== this.current?.id) return;
    const [next] = await this.list();
    if (next) return this.open(next.id);
    this.current = null;
    await idbDelete(KEY_CURRENT);
    this._emit('closed');
  },

  // Importa sem trocar o documento atual (lista de documentos / pasta).
  // Devolve { status: 'added' | 'updated' | 'conflict', id }. Lança WizardFormatError se não for Wizard.
  // ask: se o documento já existe com outra versão, não muda nada e devolve 'conflict' (4g);
  // choice: a decisão para esse caso — 'file' (usar o arquivo), 'new' (abrir como novo), 'local' (manter o navegador)
  async importQuiet(raw, fh, permission, dir = null, { ask = false, choice = null } = {}) {
    const { doc, fromVersion, fixedIds } = parseWizardText(raw, fh?.name);
    const changedByImport = fromVersion !== null || fixedIds > 0;
    let existing = await docStore.get(doc.id);

    // Mesmo id, mas outro arquivo (uma cópia do documento): entra como documento separado
    if (existing && fh && existing.fileHandle && !(await existing.fileHandle.isSameEntry(fh).catch(() => false))) {
      doc.id = uuid();
      existing = null;
    }
    if (!existing && fh) existing = await this._findByHandle(fh);

    if (!existing) {
      await docStore.put(this._record(doc, { fileHandle: fh, permission, savedText: raw, state: fh && !changedByImport ? 'saved' : 'dirty', dirHandle: dir }));
      return { status: 'added', id: doc.id };
    }

    // É o documento aberto? Então as mudanças vão nele mesmo (não numa cópia lida do banco),
    // e a tela é redesenhada ('file') — assim a pasta ligada já mostra as mídias
    const isCurrent = existing.id === this.current?.id;
    if (isCurrent) existing = this.current;
    const differs = raw !== existing.savedText;
    if (differs && (ask || choice)) {
      if (!choice) return { status: 'conflict', id: existing.id, name: existing.name, file: fh?.name ?? '', dirty: existing.state === 'dirty' };
      if (choice === 'new') {   // o do navegador fica intacto e desligado do arquivo; o arquivo vira outro documento
        Object.assign(existing, { fileHandle: null, fileName: null, permission: 'none', state: 'dirty' });
        if (isCurrent) await this._commit('local'); else await docStore.put(existing);
        const copy = this._record({ ...doc, id: uuid() }, { fileHandle: fh, permission, savedText: raw, state: 'saved', dirHandle: dir });
        await docStore.put(copy);
        return { status: 'added', id: copy.id };
      }
      Object.assign(existing, { fileHandle: fh ?? existing.fileHandle, fileName: fh?.name ?? existing.fileName, permission, dirHandle: dir ?? existing.dirHandle ?? null });
      if (choice === 'file') Object.assign(existing, { name: doc.name, blocks: doc.blocks, modifiedAt: doc.modifiedAt, savedText: raw, state: 'saved' });
      else existing.state = 'dirty';   // 'local': o Salvar grava a versão do navegador no arquivo
      if (isCurrent) await this._commit('file'); else await docStore.put(existing);
      return { status: 'updated', id: existing.id };
    }

    // Já existe: liga ao arquivo; atualiza o conteúdo só se não houver alterações locais pendentes
    Object.assign(existing, { fileHandle: fh ?? existing.fileHandle, fileName: fh?.name ?? existing.fileName, permission, dirHandle: dir ?? existing.dirHandle ?? null });
    if (!isCurrent && existing.state !== 'dirty' && raw !== existing.savedText) {
      Object.assign(existing, { name: doc.name, blocks: doc.blocks, modifiedAt: doc.modifiedAt, savedText: raw, state: 'saved' });
    }
    if (isCurrent) await this._commit('file'); else await docStore.put(existing);
    return { status: 'updated', id: existing.id };
  },

  // Um arquivo escolhido pelo seletor, sem trocar o documento atual
  async addFile() {
    if (!this.supported) {   // Firefox/Safari (18e): seletor simples; o documento entra sem ligação com o arquivo
      const file = await pickJsonFile();
      if (!file) throw new DOMException('cancelado', 'AbortError');
      return this.importQuiet(await file.text(), null, 'none');
    }
    const [fh] = await window.showOpenFilePicker({ types: JSON_TYPES });
    const granted = (await fh.requestPermission({ mode: 'readwrite' })) === 'granted';
    return this.importQuiet(await (await fh.getFile()).text(), fh, granted ? 'readwrite' : 'read');
  },

  // Pasta: percorre os .json (e todas as subpastas), valida o formato e adiciona os documentos Wizard.
  // Os documentos ficam ligados aos arquivos: o Salvar sobrescreve direto.
  // Documento que já está no navegador com outra versão: nada muda sem confirmação (4g).
  async openFolder(dir = null) {
    dir ??= await window.showDirectoryPicker({ mode: 'readwrite' });
    const permission = (await dir.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'readwrite' : 'read';
    return this.importFolder(await collectJsonFiles(dir), permission);
  },

  // files: [{ fh, dir }] · decide(conflitos) → Map(id → 'file' | 'new' | 'local') (padrão: a janela de escolha)
  async importFolder(files, permission, decide = askFolderConflicts) {
    const result = { added: [], updated: [], skipped: [] };
    const conflicts = [];
    for (const { fh, dir: folder } of files) {
      try {
        const raw = await (await fh.getFile()).text();
        const r = await this.importQuiet(raw, fh, permission, folder, { ask: true });
        if (r.status === 'conflict') conflicts.push({ ...r, raw, fh, folder });
        else result[r.status].push(r.id);
      } catch (err) {
        if (!(err instanceof WizardFormatError)) console.warn(fh.name, err);
        result.skipped.push(fh.name);
      }
    }
    if (conflicts.length) {
      const choices = await decide(conflicts);
      for (const c of conflicts) {
        const r = await this.importQuiet(c.raw, c.fh, permission, c.folder, { choice: choices.get(c.id) || 'local' });
        result[r.status].push(r.id);
      }
    }
    return result;
  },

  // Ao reabrir: o arquivo ligado mudou fora do Wizard? (só lê se a permissão ainda existir)
  async checkFile() {
    const rec = this.current;
    if (!rec?.fileHandle) return;
    let raw;
    try {
      if ((await rec.fileHandle.queryPermission({ mode: 'read' })) !== 'granted') return;
      raw = await (await rec.fileHandle.getFile()).text();
    } catch { return; }                         // arquivo movido/apagado: continua com o navegador
    if (raw === rec.savedText) return;

    let parsed;
    try { parsed = parseWizardText(raw, rec.fileName); } catch { return; }   // arquivo estragado lá fora
    const wasDirty = rec.state === 'dirty';
    await this._resolveWithExisting(rec, parsed, raw, rec.fileHandle, rec.permission);
    if (!wasDirty) toast(t('file.updated'), t('file.updatedMsg'));
    this._emit('file');
  },

  // ── Editar ───────────────────────────────────────────────────
  // Grava o documento atual no IndexedDB. mutate(rec) pode alterar o registro antes.
  // op = tipo da operação no histórico (Undo/Redo); record: false não registra (ex.: o próprio desfazer)
  async update(mutate, { op = 'EDITAR_CAMPO', record = true } = {}) {
    const rec = this.current;
    if (!rec) return;
    mutate?.(rec);
    rec.modifiedAt = new Date().toISOString();
    rec.state = 'dirty';
    if (record && typeof Timeline !== 'undefined') Timeline.record(op, rec);
    await this._commit('local');
    keepStorage();          // B19
    this._remindFile(rec);  // B20
  },

  // Documento que nunca foi salvo em arquivo só existe no navegador (B20): depois de um tempo editando,
  // um aviso leve sugere salvar (com o botão Salvar agora) e se repete de tempos em tempos.
  FILE_REMINDER: { first: 5 * 60 * 1000, every: 30 * 60 * 1000 },
  _reminders: new Map(),   // id do documento → { start, next } (só nesta sessão)
  _remindFile(rec) {
    if (rec.fileHandle) return this._reminders.delete(rec.id);
    const now = Date.now();
    let r = this._reminders.get(rec.id);
    if (!r) this._reminders.set(rec.id, r = { next: now + this.FILE_REMINDER.first });
    if (now < r.next) return;
    r.next = now + this.FILE_REMINDER.every;
    toast(t('remind.title'), t('remind.msg'), { action: { label: t('remind.save'), run: guardSave(() => this.save()) } });
  },

  // ── Salvar (1e) ──────────────────────────────────────────────
  async save() {
    const rec = this.current;
    if (!this.supported) return this._download();
    // Documento com mídia e sem pasta do projeto: o Salvar pede a pasta (JSON + mídias juntos)
    if (hasDocMedia(rec) && !rec.dirHandle) return this.saveToFolder();
    if (!rec.fileHandle || rec.permission !== 'readwrite') return this.saveAs();

    // A permissão pode ter sido esquecida (navegador fechado): pede de novo, dentro do clique
    let perm = await rec.fileHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await rec.fileHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      rec.permission = 'read';
      await this._commit('local');
      toast(t('save.denied'), t('save.deniedMsg'));
      return this.saveAs();
    }
    if (hasDocMedia(rec) && (await rec.dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted'
        && (await rec.dirHandle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      toast(t('save.denied'), t('save.deniedMsg'));
      return;
    }

    // O arquivo mudou fora do Wizard desde a última sincronização?
    let current = null;
    try { current = await (await rec.fileHandle.getFile()).text(); } catch { /* sumiu: será recriado */ }
    if (current !== null && rec.savedText !== null && current !== rec.savedText) {
      const choice = await askChoice({
        title: t('conflict.saveTitle'),
        message: t('conflict.saveMsg', { file: rec.fileName }),
        options: [
          { value: 'saveas',    label: t('conflict.saveAsNew'), primary: true },
          { value: 'overwrite', label: t('conflict.overwrite'), danger: true },
          { value: 'cancel',    label: t('action.cancel') },
        ],
      });
      if (choice === 'cancel') return;
      if (choice === 'saveas') return this.saveAs();
    }
    return this._writeTo(rec.fileHandle);
  },

  async saveAs() {
    const rec = this.current;
    if (!this.supported) return this._download();
    if (hasDocMedia(rec)) return this.saveToFolder({ asNew: true });
    const fh = await window.showSaveFilePicker({ suggestedName: `${safeFileName(rec.name)}.json`, types: JSON_TYPES });

    // O arquivo escolhido já tem conteúdo (e não é o próprio arquivo deste documento)?
    const sameFile = rec.fileHandle ? await rec.fileHandle.isSameEntry(fh).catch(() => false) : false;
    const existingText = stripBOM(await (await fh.getFile()).text());
    if (existingText.trim() && !sameFile) {
      let info = null;
      try { info = parseWizardText(existingText, fh.name); } catch { /* não é Wizard */ }
      const choice = await askChoice({
        title: t('exists.title', { file: fh.name }),
        message: info ? t('exists.msgDoc', { n: info.doc.blocks.length }) : t('exists.msgOther'),
        options: [
          info && { value: 'open', label: t('exists.open') },
          { value: 'replace', label: t('exists.replace'), danger: true, primary: !info },
          { value: 'cancel',  label: t('action.cancel') },
        ],
      });
      if (choice === 'cancel') return;
      if (choice === 'open') return this.openHandle(fh, 'readwrite');
    }
    return this._writeTo(fh);
  },

  async _writeTo(fh) {
    const rec  = this.current;
    const text = serializeDocument(rec);
    await writeFile(fh, text);
    if (hasDocMedia(rec) && rec.dirHandle) await Media.exportTo(rec, rec.dirHandle);   // mídias ao lado do JSON
    Object.assign(rec, { fileHandle: fh, fileName: fh.name, permission: 'readwrite', savedText: text, state: 'saved' });
    await this._commit('local');
    toast(t('save.done'), t('save.doneMsg', { file: fh.name }));
  },

  // Documento com mídia: o arquivo é uma PASTA de projeto (o JSON + as mídias ao lado).
  // asNew: "Salvar como" — sempre escolhe (ou cria) outro JSON na pasta.
  async saveToFolder({ asNew = false } = {}) {
    const rec = this.current;
    toast(t('save.needFolder'), t('save.needFolderMsg'));
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'wizard-project' });

    // O JSON atual já está nesta pasta? Então continua sendo ele
    let fh = null;
    if (!asNew && rec.fileHandle) {
      const path = await dir.resolve(rec.fileHandle).catch(() => null);
      if (path && path.length === 1) fh = rec.fileHandle;
    }
    if (!fh) {
      const name = `${safeFileName(rec.name)}.json`;
      let existing = null;
      try { existing = await dir.getFileHandle(name); } catch { /* ainda não existe */ }
      if (existing) {
        const text = stripBOM(await (await existing.getFile()).text());
        let info = null;
        try { info = text.trim() ? parseWizardText(text, name) : null; } catch { /* não é Wizard */ }
        if (text.trim() && info?.doc.id !== rec.id) {
          const choice = await askChoice({
            title: t('exists.title', { file: name }),
            message: info ? t('exists.msgDoc', { n: info.doc.blocks.length }) : t('exists.msgOther'),
            options: [
              info && { value: 'open', label: t('exists.open') },
              { value: 'replace', label: t('exists.replace'), danger: true, primary: !info },
              { value: 'cancel',  label: t('action.cancel') },
            ],
          });
          if (choice === 'cancel') return;
          if (choice === 'open') return this.openHandle(existing, 'readwrite');
        }
      }
      fh = existing || await dir.getFileHandle(name, { create: true });
    }
    rec.dirHandle = dir;
    return this._writeTo(fh);
  },

  _download() {
    const rec = this.current;
    downloadText(serializeDocument(rec), `${safeFileName(rec.name)}.json`);
    this._reminders.set(rec.id, { next: Date.now() + this.FILE_REMINDER.every });   // baixado: o lembrete espera
    // Com mídia (18e): só o JSON foi baixado; as mídias ficam no navegador
    toast(t('save.downloaded'), t(hasDocMedia(rec) ? 'save.downloadedNoMedia' : 'save.downloadedMsg'));
  },
};

// O documento tem imagem/vídeo? (media.js pode não estar carregado em páginas sem mídia)
const hasDocMedia = rec => typeof Media !== 'undefined' && Media.hasMedia(rec);

// Lista os arquivos .json de uma pasta e de todas as subpastas (4f), com a pasta de cada um.
// Pula pastas ocultas e de dependências; limites de segurança: 12 níveis e 2000 arquivos.
const FOLDER_MAX_DEPTH = 12, FOLDER_MAX_FILES = 2000;
const SKIP_DIRS = /^(\.|node_modules$|__pycache__$)/;
async function collectJsonFiles(dir, depth = FOLDER_MAX_DEPTH, files = []) {
  for await (const entry of dir.values()) {
    if (files.length >= FOLDER_MAX_FILES) break;
    if (entry.kind === 'file' && /\.json$/i.test(entry.name)) files.push({ fh: entry, dir });
    else if (entry.kind === 'directory' && depth > 0 && !SKIP_DIRS.test(entry.name)) await collectJsonFiles(entry, depth - 1, files);
  }
  return files;
}

// Cópia nova do mesmo documento (outra aba, arquivo): as partes do nível de cima (e os contêineres dos
// capítulos) com o mesmo conteúdo passam a usar os objetos antigos, e a tela as reaproveita sem redesenhar (B23).
// Capítulo que mudou só nos contêineres continua sendo o objeto antigo, com a lista nova.
function keepSameNodes(oldRec, newRec) {
  const graft = (oldList, newList) => {
    const olds = new Map((oldList || []).map(n => [n.id, n]));
    newList?.forEach((n, i) => {
      const o = olds.get(n.id);
      if (!o || o.type !== n.type) return;
      if (JSON.stringify(o) === JSON.stringify(n)) { newList[i] = o; return; }
      if (n.type === 'chapter' && JSON.stringify({ ...o, content: undefined }) === JSON.stringify({ ...n, content: undefined })) {
        graft(o.content, n.content);
        o.content = n.content;
        newList[i] = o;
      }
    });
  };
  graft(oldRec?.blocks, newRec?.blocks);
}

// ── Sincronização entre abas (1g) ──────────────────────────────
docsChannel?.addEventListener('message', async e => {
  const msg = e.data;
  if (msg?.type !== 'doc' || msg.writer === TAB_ID || msg.id !== Docs.current?.id) return;
  const rec = await docStore.get(msg.id);
  if (!rec || (rec.rev === Docs.current.rev && rec.writer === Docs.current.writer)) return;
  keepSameNodes(Docs.current, rec);
  Docs.current = rec;
  Docs._emit('tab');
});

/* ============================================================
   UI compartilhada: estado do documento, botão Salvar, tela inicial
   ============================================================ */

// Mostra nome, bolinha de estado (amarela = alterações não salvas) e selo de somente leitura
function renderDocStatus(el) {
  const rec = Docs.current;
  if (!el || !rec) return;
  const dirty = rec.state === 'dirty';
  const tip = rec.permission === 'read' ? t('doc.readOnly') : !rec.fileHandle ? t('doc.noFile') : dirty ? t('doc.unsaved') : t('doc.saved');
  el.innerHTML = `
    <span class="doc-dot${dirty ? ' dirty' : ''}"></span>
    <span class="doc-status-name">${esc(rec.name)}${rec.fileName ? ` · ${esc(rec.fileName)}` : ''}</span>
    ${rec.permission === 'read' ? `<span class="doc-badge">R/O</span>` : ''}`;
  el.title = tip;
  el.querySelector('.doc-dot').title = tip;
}

// Salvar num clique: cancelar o seletor não é erro; outros erros viram aviso
const guardSave = fn => async () => {
  try { await fn(); }
  catch (err) { if (!isAbort(err)) { console.warn(err); toast(t('save.error'), err.message); } }
};

// Clique = Salvar · clique direito / toque longo = menu com Salvar e Salvar como
function initSaveButton(btn) {
  btn.addEventListener('click', guardSave(() => Docs.save()));
  onContextAction(btn, (x, y) => showContextMenu(x, y, [
    { label: t('action.save'),   run: () => Docs.save() },
    { label: t('action.saveAs'), run: () => Docs.saveAs() },
  ]));
}

function initLanguageButton(btn) {
  if (!btn) return;
  btn.addEventListener('click', () => setLang(LANG === 'pt' ? 'en' : 'pt'));
}

// Tela inicial: Novo · Novo a partir de modelo · Ver um exemplo · Abrir arquivo · Abrir pasta · Login com Google*
// · Reconectar (versão anterior). * visível, mas ainda sem funcionar.
// Navegador sem acesso a arquivos (Firefox, Safari): abrir e salvar por download, com um aviso (18e)
async function chooseDocument({ title, subtitle, cancel = false, onReady }) {
  const ready = async () => { hideLoadScreen(); await onReady(Docs.current); };
  const legacy = Docs.supported ? await Docs.legacyHandle() : null;

  const openWithInput = async () => {
    const file = await pickJsonFile();
    if (file) { await Docs.openFileObject(file); await ready(); }
  };

  const guarded = fn => async () => {
    try { await fn(); }
    catch (err) {
      if (isAbort(err)) return;
      if (err instanceof WizardFormatError) toast(t('open.invalid'), err.message);
      else throw err;
    }
  };

  const soon = msg => () => toast(t('soon.title'), msg);

  showLoadScreen({
    title, subtitle, cancel,
    handle: legacy,
    note: Docs.supported ? null : t('browser.limited'),
    actions: [
      legacy && { label: t('action.reconnect'), primary: true, run: guarded(async () => { await Docs.reconnectLegacy(legacy); await ready(); }) },
      { label: t('action.newDoc'), primary: !legacy, run: async () => { await Docs.createNew(); await ready(); } },
      { label: t('action.newFromTemplate'), run: async () => { await Docs.createFromTemplate(); await ready(); } },
      { label: t('action.example'), run: guarded(async () => { await Docs.openExample(); await ready(); }) },
      { label: t('action.openFile'), run: guarded(async () => {
        if (Docs.supported) { await Docs.openFile(); await ready(); } else await openWithInput();
      }) },
      'showDirectoryPicker' in window && { label: t('action.openFolder'), run: guarded(async () => {
        const result = await Docs.openFolder();
        toastFolderResult(result);
        openDocManager({ newIds: [...result.added, ...result.updated], onOpen: ready });
      }) },
      { label: t('action.google'), icon: GOOGLE_ICON, disabled: true, title: t('soon.login'), run: soon(t('soon.login')) },
    ],
  });
}

// Documentos da pasta que já estão no navegador com outra versão (4g): escolha por arquivo ou para todos.
// Cancelar (ou Esc) = manter o navegador em todos. Devolve Map(id → 'file' | 'new' | 'local').
function askFolderConflicts(conflicts) {
  return new Promise(resolve => {
    const opts = [['local', t('conflict.keepLocal')], ['file', t('conflict.useFile')], ['new', t('conflict.newDoc')]];
    const select = (name, value = 'local') => `<select class="wz-modal-input fc-select" data-id="${esc(name)}">${opts.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const overlay = document.createElement('div');
    overlay.className = 'wz-modal';
    overlay.innerHTML = `
      <div class="wz-modal-box wz-modal-wide" role="dialog" aria-modal="true">
        <div class="wz-modal-title">${esc(t('folder.conflictTitle'))}</div>
        <div class="wz-modal-msg">${esc(t('folder.conflictMsg', { n: conflicts.length }))}</div>
        <div class="fc-all"><span>${esc(t('folder.all'))}</span>${select('__all')}</div>
        <div class="fc-list">${conflicts.map(c => `
          <div class="fc-row">
            <div class="fc-info"><div class="fc-name">${esc(c.name)}</div><div class="fc-file">${esc(c.file)}${c.dirty ? ` · <span class="fc-dirty">${esc(t('folder.dirty'))}</span>` : ''}</div></div>
            ${select(c.id)}
          </div>`).join('')}</div>
        <div class="wz-modal-actions">
          <button class="ls-btn-primary" data-v="ok">${esc(t('folder.apply'))}</button>
          <button class="ls-btn-secondary" data-v="cancel">${esc(t('action.cancel'))}</button>
        </div>
      </div>`;
    const rows = [...overlay.querySelectorAll('.fc-list .fc-select')];
    overlay.querySelector('[data-id="__all"]').addEventListener('change', e => rows.forEach(s => { s.value = e.target.value; }));
    const close = ok => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(new Map(conflicts.map((c, i) => [c.id, ok ? rows[i].value : 'local'])));
    };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); } };
    overlay.querySelector('[data-v=ok]').addEventListener('click', () => close(true));
    overlay.querySelector('[data-v=cancel]').addEventListener('click', () => close(false));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-v=ok]').focus();
  });
}

function toastFolderResult({ added, updated, skipped }) {
  toast(t('folder.done'), t('folder.doneMsg', { added: added.length, updated: updated.length, skipped: skipped.length }));
}

// Ícone "G" para o botão de login (sem funcionar por enquanto)
const GOOGLE_ICON = `<svg class="ls-icon" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
