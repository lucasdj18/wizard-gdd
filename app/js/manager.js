/* ============================================================
   manager.js — gerenciador de documentos (popup "📄 Documentos")

   · Lista todos os documentos do IndexedDB, do mais recente para o mais antigo.
   · Clique abre · clique direito / toque longo / ⋯ → Abrir, Renomear, Baixar, Apagar.
   · No fim: Carregar arquivo, Carregar pasta, Novo documento, Novo a partir de modelo (18b) e Ver um exemplo (18c).
   · Tag NEW nos documentos adicionados enquanto o popup está aberto
     (ao fechar e abrir de novo, todos são tratados como antigos).
   ============================================================ */

// opts: { newIds: ids que já chegam como NEW (ex.: pasta aberta pela tela inicial),
//         onOpen: o que fazer depois de abrir um documento }
async function openDocManager({ newIds = [], onOpen = null } = {}) {
  document.querySelector('.dm-overlay')?.remove();
  const fresh = new Set(newIds);           // NEW só vale enquanto este popup estiver aberto

  const overlay = document.createElement('div');
  overlay.className = 'wz-modal dm-overlay';
  overlay.innerHTML = `
    <div class="wz-modal-box wz-modal-wide dm-box" role="dialog" aria-modal="true">
      <div class="wz-modal-title">${esc(t('docs.title'))}</div>
      <div class="dm-list" role="list"></div>
      <div class="dm-actions">
        <button class="ls-btn-secondary" data-act="file">${esc(t('action.addFile'))}</button>
        ${'showDirectoryPicker' in window ? `<button class="ls-btn-secondary" data-act="folder">${esc(t('action.addFolder'))}</button>` : ''}
        <button class="ls-btn-secondary" data-act="new">${esc(t('action.newDoc'))}</button>
        <button class="ls-btn-secondary" data-act="template">${esc(t('action.newFromTemplate'))}</button>
        <button class="ls-btn-secondary" data-act="example">${esc(t('action.example'))}</button>
        <button class="ls-btn-secondary" data-act="close">${esc(t('action.close'))}</button>
      </div>
    </div>`;
  const list = overlay.querySelector('.dm-list');

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.wz-menu, .wz-modal:not(.dm-overlay)')) close(); };
  const run = fn => async () => {
    try { await fn(); }
    catch (err) {
      if (isAbort(err)) return;
      if (err instanceof WizardFormatError) toast(t('open.invalid'), err.message);
      else { console.warn(err); toast('⚠', err.message); }
    }
  };

  // Antes de trocar: o documento atual precisa estar gravado no navegador (10a)
  const leaveCurrent = async () => {
    const prev = Docs.current;
    if (!(await Docs.ensureStored())) { toast(t('docs.notStored'), t('docs.notStoredMsg')); return null; }
    return prev || true;
  };
  const openDoc = async id => {
    if (!(await leaveCurrent())) return;
    close();
    await Docs.open(id);
    await onOpen?.(Docs.current);
  };

  async function render() {
    const docs = await Docs.list();
    list.innerHTML = '';
    if (!docs.length) list.innerHTML = `<div class="dm-empty">${esc(t('docs.empty'))}</div>`;

    docs.forEach(rec => {
      const row = document.createElement('div');
      row.className = 'dm-row' + (rec.id === Docs.current?.id ? ' current' : '');
      row.setAttribute('role', 'listitem');
      row.tabIndex = 0;
      row.dataset.id = rec.id;
      const when = new Date(rec.modifiedAt).toLocaleString(LANG === 'pt' ? 'pt-BR' : 'en', { dateStyle: 'short', timeStyle: 'short' });
      row.innerHTML = `
        <span class="doc-dot${rec.state === 'dirty' ? ' dirty' : ''}"></span>
        <div class="dm-info">
          <div class="dm-name">${esc(rec.name)}${fresh.has(rec.id) ? ` <span class="dm-new">NEW</span>` : ''}${rec.id === Docs.current?.id ? ` <span class="dm-current">${esc(t('docs.current'))}</span>` : ''}</div>
          <div class="dm-meta">${esc(rec.fileName || t('doc.noFile'))} · ${esc(when)}</div>
        </div>
        <button class="btn-entry-menu" title="${esc(t('editor.menu'))}">⋯</button>`;

      row.addEventListener('click', e => { if (!e.target.closest('.btn-entry-menu')) run(() => openDoc(rec.id))(); });
      row.addEventListener('keydown', e => { if (e.key === 'Enter') run(() => openDoc(rec.id))(); });
      const menu = (x, y) => showContextMenu(x, y, [
        { label: t('menu.open'),     run: () => openDoc(rec.id) },
        { label: t('menu.rename'),   run: run(async () => {
          const name = await askText({ title: t('menu.rename'), value: rec.name, okLabel: t('menu.rename') });
          if (name === null) return;
          await Docs.rename(rec.id, name);
          if (rec.id === Docs.current?.id && typeof renderEditor === 'function') renderEditor();
          await render();
        }) },
        { label: t('menu.download'), run: () => Docs.download(rec.id) },
        { label: t('menu.delete'), danger: true, run: run(async () => {
          const choice = await askChoice({
            title: t('delete.title'),
            message: t('docs.deleteMsg', { name: rec.name }),
            options: [
              { value: 'delete', label: t('menu.delete'), danger: true },
              { value: 'cancel', label: t('action.cancel'), primary: true },
            ],
          });
          if (choice !== 'delete') return;
          await Docs.remove(rec.id);
          if (!Docs.current) { close(); return; }
          await render();
        }) },
      ]);
      onContextAction(row, (x, y) => menu(x, y));
      row.querySelector('.btn-entry-menu').addEventListener('click', e => {
        const r = e.currentTarget.getBoundingClientRect();
        menu(r.right - 200, r.bottom);
      });
      list.appendChild(row);
    });
  }

  overlay.querySelector('[data-act=file]').addEventListener('click', run(async () => {
    const { id } = await Docs.addFile();
    fresh.add(id);
    await render();
  }));
  overlay.querySelector('[data-act=folder]')?.addEventListener('click', run(async () => {
    const result = await Docs.openFolder();
    [...result.added, ...result.updated].forEach(id => fresh.add(id));
    toastFolderResult(result);
    await render();
  }));
  // Novo documento (em branco, do modelo ou o exemplo): confirma que o atual está salvo no navegador e vai direto
  const goTo = create => run(async () => {
    const prev = await leaveCurrent();
    if (!prev) return;
    await create();
    close();
    await onOpen?.(Docs.current);
    if (prev !== true && prev.id !== Docs.current?.id) toast(t('docs.stored'), t('docs.storedMsg', { name: prev.name }));
  });
  overlay.querySelector('[data-act=new]').addEventListener('click', goTo(() => Docs.createNew()));
  overlay.querySelector('[data-act=template]').addEventListener('click', goTo(() => Docs.createFromTemplate()));   // 18b
  overlay.querySelector('[data-act=example]').addEventListener('click', goTo(() => Docs.openExample()));          // 18c
  overlay.querySelector('[data-act=close]').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay && Docs.current) close(); });

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  await render();
  list.querySelector('.dm-row')?.focus();
}
