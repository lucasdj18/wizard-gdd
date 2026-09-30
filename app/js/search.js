/* ============================================================
   search.js — Buscar (Ctrl+F) e Substituir (Ctrl+L) no documento (15c)

   · Procura em todos os campos editáveis (nome, títulos, textos, células,
     chaves, valores, tarefas, legendas), sem diferenciar maiúsculas nem acentos.
   · Enter / ↓ vai para o próximo, Shift+Enter / ↑ para o anterior, Esc fecha.
   · Substituir troca o resultado atual; Substituir tudo é uma operação só no Desfazer.
   · Ctrl+F e Ctrl+L são do navegador (buscar / barra de endereço): o Wizard
     assume os dois enquanto o editor está aberto.
   ============================================================ */

const Search = {
  bar: null,
  hits: [],       // [{ el, index }] — posição no texto do campo (o valor bruto, como é editado)
  current: -1,

  // Uma letra por posição: sem acento e minúscula (o índice continua o mesmo do texto original)
  fold: s => [...String(s)].map(c => c.normalize('NFD')[0].toLowerCase()).join(''),

  open(replace = false) {
    if (!Docs.current) return;
    document.querySelector('.cell-editing input, .cell-editing textarea')?.blur();
    if (!this.bar) this._build();
    this.bar.classList.toggle('with-replace', replace);
    this.bar.hidden = false;
    const q = this.bar.querySelector('.sr-find');
    const sel = String(getSelection?.() || '').trim();
    if (sel && !sel.includes('\n')) q.value = sel;
    q.focus(); q.select();
    this.run();
  },

  close() {
    if (!this.bar) return;
    this.bar.hidden = true;
    this._clearMarks();
    this.hits = []; this.current = -1;
  },

  _build() {
    const bar = document.createElement('div');
    bar.className = 'search-bar';
    bar.setAttribute('role', 'search');
    bar.innerHTML = `
      <div class="sr-line">
        <input class="sr-find" type="text" placeholder="${esc(t('search.find'))}" aria-label="${esc(t('search.find'))}">
        <span class="sr-count" aria-live="polite"></span>
        <button class="sr-btn" data-a="prev" title="${esc(t('search.prev'))}">↑</button>
        <button class="sr-btn" data-a="next" title="${esc(t('search.next'))}">↓</button>
        <button class="sr-btn" data-a="toggle" title="${esc(t('search.replaceTip'))}">⇄</button>
        <button class="sr-btn" data-a="close" title="${esc(t('action.close'))}">✕</button>
      </div>
      <div class="sr-line sr-replace-line">
        <input class="sr-rep" type="text" placeholder="${esc(t('search.replace'))}" aria-label="${esc(t('search.replace'))}">
        <button class="sr-btn sr-wide" data-a="one">${esc(t('search.replaceOne'))}</button>
        <button class="sr-btn sr-wide" data-a="all">${esc(t('search.replaceAll'))}</button>
      </div>`;
    document.body.appendChild(bar);
    this.bar = bar;
    const find = bar.querySelector('.sr-find');
    find.addEventListener('input', () => this.run());
    bar.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
      else if (e.key === 'Enter' && e.target === find) { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Enter' && e.target.matches('.sr-rep')) { e.preventDefault(); e.ctrlKey ? this.replaceAll() : this.replaceOne(); }
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target === find) { e.preventDefault(); this.step(e.key === 'ArrowUp' ? -1 : 1); }
    });
    bar.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'prev') this.step(-1);
      if (a === 'next') this.step(1);
      if (a === 'close') this.close();
      if (a === 'toggle') { bar.classList.toggle('with-replace'); (bar.classList.contains('with-replace') ? bar.querySelector('.sr-rep') : find).focus(); }
      if (a === 'one') this.replaceOne();
      if (a === 'all') this.replaceAll();
    });
  },

  get query() { return this.bar?.querySelector('.sr-find').value || ''; },

  // Todos os resultados, na ordem da página (keepIndex: tenta manter o resultado atual)
  run(keepIndex = false) {
    const prev = this.hits[this.current];
    this._clearMarks();
    this.hits = [];
    const q = this.fold(this.query);
    if (q) {
      for (const el of mainEl().querySelectorAll('.editable')) {
        if (!el._edit) continue;
        const text = this.fold(el._edit.get());
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) this.hits.push({ el, index: i });
      }
    }
    // Depois de substituir: continua no próximo resultado (no mesmo campo ou num campo seguinte)
    const after = h => h.el === prev.el ? h.index >= prev.index
      : !!(prev.el.compareDocumentPosition(h.el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const pos = keepIndex && prev?.el.isConnected ? this.hits.findIndex(after) : 0;
    this.current = !this.hits.length ? -1 : Math.max(0, pos);
    this._mark();
  },

  step(dir) {
    if (!this.hits.length) return;
    this.current = (this.current + dir + this.hits.length) % this.hits.length;
    this._mark();
  },

  _clearMarks() {
    document.querySelectorAll('.search-hit, .search-current').forEach(el => el.classList.remove('search-hit', 'search-current'));
    CSS.highlights?.delete('wz-search');
    CSS.highlights?.delete('wz-search-current');
  },

  // Campo com resultado ganha contorno; o texto encontrado é realçado (CSS Custom Highlight, quando existe)
  _mark() {
    this._clearMarks();
    const count = this.bar.querySelector('.sr-count');
    count.textContent = this.query ? (this.hits.length ? `${this.current + 1}/${this.hits.length}` : t('search.none')) : '';
    count.classList.toggle('none', !!this.query && !this.hits.length);
    if (!this.hits.length) return;
    this.hits.forEach(h => h.el.classList.add('search-hit'));
    const cur = this.hits[this.current];
    cur.el.classList.add('search-current');
    cur.el.scrollIntoView({ block: 'center', behavior: 'smooth' });

    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    const q = this.fold(this.query);
    const all = new Highlight(), now = new Highlight();
    for (const el of new Set(this.hits.map(h => h.el))) {
      // no texto mostrado (com fórmulas já resolvidas), procura de novo para achar os nós de texto
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = this.fold(n.data);
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
          const r = new Range();
          r.setStart(n, i); r.setEnd(n, i + q.length);
          (el === cur.el && seen === this.hits.filter(h => h.el === el).indexOf(cur) ? now : all).add(r);
          seen++;
        }
      }
    }
    CSS.highlights.set('wz-search', all);
    CSS.highlights.set('wz-search-current', now);
  },

  // Troca uma ocorrência dentro do valor bruto do campo
  _replaceIn(value, index, len, rep) { return value.slice(0, index) + rep + value.slice(index + len); },

  replaceOne() {
    const hit = this.hits[this.current];
    if (!hit) return;
    const rep = this.bar.querySelector('.sr-rep').value;
    const raw = String(hit.el._edit.get());
    hit.el._edit.set(this._replaceIn(raw, hit.index, this.query.length, rep));   // cada troca é uma edição (Desfazer)
    renderRich(hit.el, hit.el._edit.get());
    this.run(true);
  },

  // Substituir tudo: uma operação só no histórico
  async replaceAll() {
    if (!this.hits.length) return;
    const rep = this.bar.querySelector('.sr-rep').value, len = this.query.length, n = this.hits.length;
    const byEl = new Map();
    this.hits.forEach(h => byEl.set(h.el, [...(byEl.get(h.el) || []), h.index]));
    batchEdits = true;   // os set() não gravam um por um (editor.js: persist)
    try {
      for (const [el, idxs] of byEl) {
        let raw = String(el._edit.get());
        [...idxs].sort((a, b) => b - a).forEach(i => { raw = this._replaceIn(raw, i, len, rep); });   // de trás para frente
        el._edit.set(raw);
      }
    } finally { batchEdits = false; }
    await Docs.update(null, { op: 'SUBSTITUIR' });
    renderEditor();
    this.run();
    toast(t('search.replacedAll', { n }));
  },
};

// Atalhos: Ctrl+F busca, Ctrl+L substitui (com o editor aberto e sem janela por cima)
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'f' && k !== 'l') return;
  if (!Docs.current || !document.getElementById('editor-app')?.classList.contains('visible') || document.querySelector('.wz-modal')) return;
  e.preventDefault();
  Search.open(k === 'l');
});
// Redesenhou (outra edição, outra aba): os resultados são recalculados
window.addEventListener('wizard:rendered', () => { if (Search.bar && !Search.bar.hidden) Search.run(true); });
