/* ============================================================
   editor-sidebar.js — sinais da sidebar (15e), preferências e ⚙ Configurações
   Parte do editor (editor.js); carregado antes dele.
   ============================================================ */

/* ── Sinais na sidebar (15e) ────────────────────────────────────
   Uma faixa à direita de cada índice: comentário, vazio, incompleto, checklist, destaque, dado inválido.
   Em ⚙ Configurações o usuário escolhe se mostra e quais. */
const SIGNALS = ['comment', 'empty', 'incomplete', 'check', 'highlight', 'invalid'];
const prefs = { signals: true, ...Object.fromEntries(SIGNALS.map(k => [k, true])) };
const KEY_PREFS = 'prefs';
async function loadPrefs() { try { Object.assign(prefs, (await idbLoad(KEY_PREFS)) || {}); } catch { /* sem banco: padrão */ } }
const savePrefs = () => idbSave(KEY_PREFS, { ...prefs }).catch(() => {});

const blank = v => !String(v ?? '').trim();
// Preenchimento: 'empty' (nada), 'partial' (parte) ou null (completo / não se aplica)
function fillState(node) {
  const state = values => values.length === 0 || values.every(blank) ? 'empty' : values.some(blank) ? 'partial' : null;
  switch (node.type) {
    case 'description': case 'text': case 'obs': return blank(node.content) ? 'empty' : null;
    case 'item':      return blank(node.text) ? 'empty' : null;
    case 'image': case 'video': case 'audio': return node.src ? null : 'empty';
    case 'table':     return state((node.rows || []).flatMap(r => r.data || []));
    case 'summary':   return state((node.rows || []).flatMap(r => r.data || []));
    case 'keyvalue':  return state(Object.values(node.data || {}));
    case 'checklist': return (node.items || []).every(x => blank(x.text)) ? 'empty' : null;
    case 'topic': case 'block': case 'chapter': return node.content?.length ? null : 'empty';
    case 'grid':      return (node.content || []).every(c => !c.content?.length) ? 'empty' : null;
  }
  return null;
}

function nodeSignals(node) {
  const out = [];
  const add = (key, glyph, title = t(`sig.${key}`)) => { if (prefs[key]) out.push({ key, glyph, title }); };
  if (node.comment) add('comment', '💬', `${t('sig.comment')}: ${node.comment}`);
  if (node.highlight) add('highlight', { alert: '⚠', question: '?', spoiler: '🔒' }[node.highlight], t(`hl.${node.highlight}`));
  const fill = fillState(node);
  if (fill === 'empty') add('empty', '○');
  else if (fill === 'partial') add('incomplete', '◐');
  if (node.type === 'checklist' && node.items?.length) {
    const done = node.items.filter(x => x.done).length;
    add('check', done === node.items.length ? '✓' : `${done}/${node.items.length}`, t(done === node.items.length ? 'sig.checkDone' : 'sig.checkOpen'));
  }
  // ✗ dado inválido na tabela (15d) ou fórmula quebrada (17f)
  const why = [];
  if (node.type === 'table') {
    const kind = ci => node.columns?.[ci]?.kind ?? node.dataKind;
    if ((node.rows || []).some(r => (r.data || []).some((v, ci) => !cellValid(cellShown(node, r, ci, v), kind(ci))))) why.push(t('sig.invalid'));
  }
  const broken = [];
  ownTexts(node, (text, ctx) => { if (Formula.has(text)) broken.push(...Formula.errors(text, ctx)); });
  if (broken.length) why.push(`${t('sig.formula')}: ${t(`formula.err.${broken[0]}`)}`);
  if (why.length) add('invalid', '✗', why.join(' · '));
  return out;
}

function decorateNav(nav) {
  if (!prefs.signals) return;
  nav.querySelectorAll('a[data-anchor]').forEach(a => {
    const node = findNode(blocks(), a.dataset.anchor.slice(2));
    const sigs = node ? nodeSignals(node) : [];
    if (!sigs.length) return;
    const box = document.createElement('span');
    box.className = 'nav-signals';
    sigs.forEach(s => {
      const g = document.createElement('span');
      g.className = `nav-sig sig-${s.key}`;
      g.textContent = s.glyph;
      g.title = s.title;
      box.appendChild(g);
    });
    a.appendChild(box);
  });
}

// Passar o mouse no índice da sidebar mostra o comentário do item na página
function initNavComments() {
  const nav = document.getElementById('sidebar-nav');
  const target = e => { const a = e.target.closest?.('a[data-anchor]'); return a && document.getElementById(a.dataset.anchor); };
  nav.addEventListener('mouseover', e => target(e)?.classList.add('show-comment'));
  nav.addEventListener('mouseout',  e => target(e)?.classList.remove('show-comment'));
}

// ⚙ Configurações: por enquanto, os sinais da sidebar (o menu completo de configurações é o F3)
function openSettings() {
  const overlay = document.createElement('div');
  overlay.className = 'wz-modal';
  const row = (key, label) => `<label class="set-row"><input type="checkbox" data-k="${key}"${prefs[key] ? ' checked' : ''}> ${esc(label)}</label>`;
  overlay.innerHTML = `
    <div class="wz-modal-box" role="dialog" aria-modal="true">
      <div class="wz-modal-title">${esc(t('settings.title'))}</div>
      <div class="set-section">${esc(t('settings.signals'))}</div>
      ${row('signals', t('settings.showSignals'))}
      <div class="set-list">${SIGNALS.map(k => row(k, t(`sig.${k}`))).join('')}</div>
      <div class="wz-modal-actions"><button class="ls-btn-secondary" data-v="feedback">${esc(t('action.feedback'))}</button><button class="ls-btn-primary" data-v="close">${esc(t('action.close'))}</button></div>
    </div>`;
  overlay.querySelector('[data-v=feedback]').addEventListener('click', () => openFeedback());
  const list = overlay.querySelector('.set-list');
  const sync = () => list.classList.toggle('off', !prefs.signals);
  overlay.addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (!k) return;
    prefs[k] = e.target.checked;
    savePrefs(); sync();
    if (Docs.current) renderSidebar();
  });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  overlay.querySelector('[data-v=close]').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  sync();
  overlay.querySelector('input').focus();
}

/* ── Guia rápido (18d) e canal de retorno (18f) ───────────────── */
const GUIDE_SECTIONS = { edit: 3, keys: 3, save: 3, export: 1, formula: 3 };

// Janela simples com o conteúdo e um botão Fechar (Esc e clique fora também fecham)
function openInfoModal(title, bodyHTML, extraButtons = '') {
  const overlay = document.createElement('div');
  overlay.className = 'wz-modal';
  overlay.innerHTML = `
    <div class="wz-modal-box wz-modal-wide" role="dialog" aria-modal="true">
      <div class="wz-modal-title">${esc(title)}</div>
      ${bodyHTML}
      <div class="wz-modal-actions">${extraButtons}<button class="ls-btn-primary" data-v="close">${esc(t('action.close'))}</button></div>
    </div>`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  overlay.querySelector('[data-v=close]').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  overlay.querySelector('[data-v=close]').focus();
  return overlay;
}

function openGuide() {
  const body = Object.entries(GUIDE_SECTIONS).map(([s, n]) => `
    <div class="guide-section">
      <div class="set-section">${esc(t(`guide.${s}`))}</div>
      <ul class="guide-list">${Array.from({ length: n }, (_, i) => `<li>${esc(t(`guide.${s}.${i + 1}`))}</li>`).join('')}</ul>
    </div>`).join('');
  const overlay = openInfoModal(t('guide.title'), `<div class="guide">${body}</div>`,
    `<button class="ls-btn-secondary" data-v="feedback">${esc(t('action.feedback'))}</button>`);
  overlay.querySelector('[data-v=feedback]').addEventListener('click', openFeedback);
}

// "Enviar sugestão ou erro" (18f): abre o formulário de issue do repositório público, com a versão, o navegador e
// o idioma já preenchidos. Nada do documento vai junto (a pessoa escreve o que quiser contar).
const FEEDBACK_URL = 'https://github.com/lucasdj18/wizard-gdd/issues/new';
function appVersion() {
  const v = n => document.querySelector(`script[src*="js/${n}.js"]`)?.getAttribute('src')?.split('v=')[1] || '—';
  return `core ${v('core')} · editor ${v('editor')}`;
}
function feedbackLink() {
  const body = [t('feedback.ask'), '', '', '---',
    `${t('feedback.version')}: ${appVersion()}`,
    `${t('feedback.browser')}: ${navigator.userAgent}`,
    `${t('feedback.lang')}: ${LANG} · ${t('feedback.screen')}: ${innerWidth}×${innerHeight}`].join('\n');
  return `${FEEDBACK_URL}?${new URLSearchParams({ body })}`;
}
function openFeedback() {
  window.open(feedbackLink(), '_blank', 'noopener');
}
