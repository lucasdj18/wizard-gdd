/* ============================================================
   formula.js — fórmulas `f{…}` (fase 17)

   A fórmula fica entre crases e o UUID vem sempre primeiro:
     `f{UUID}`                 link com o título (ou texto) do alvo
     `f{UUID, 'Espada'}`       link com rótulo fixo
     `f{UUID, [2,3]}`          célula linha 2, coluna 3 (tabela, sumário, chave-valor, checklist)
     `f{UUID, [HP]}`           valor da chave "HP" (na tabela: a coluna com esse nome)
     `f{[2,3]}`                sem UUID = o próprio item onde a fórmula está
     `f{SUM(UUID, [,3])}`      funções: SUM, AVG, MIN, MAX, COUNT (vários alvos e números)
   Posições contam a partir de 1; 0 ou vazio = todas; negativas contam do fim; intervalos a:b.
   Sem autorreferência: ler a própria célula (ou uma cadeia que volta a ela) é erro ⟳.
   `f{…}` sem crases (formato antigo) é só texto.

   ctx = { blocks, self, row, col, key }: onde a fórmula está (o nó dono do campo e, na tabela,
   a linha e a coluna; na chave-valor, a chave e a coluna 0/1).
   ============================================================ */

const FORMULA_RE = /`f\{([^`]*?)\}`/g;
const FORMULA_FUNCS = ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'];
const FORMULA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMULA_NUM_RE = /^[+-]?\d+(?:[.,]\d+)?$/;
const FORMULA_MAX_TEXT = 80;

class FormulaError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

const Formula = {
  has: s => String(s ?? '').includes('`f{'),

  /* ── Leitura ─────────────────────────────────────────────── */
  // Divide nos separadores de fora de [], () e aspas
  _split(s) {
    const out = [];
    let depth = 0, quote = null, cur = '';
    for (const ch of s) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (quote || depth) throw new FormulaError('syntax');
    out.push(cur.trim());
    return out;
  },

  _token(s) {
    if (/^(['"]).*\1$/s.test(s)) return { label: s.slice(1, -1) };
    if (/^\[.*\]$/s.test(s)) return { sel: this._sel(s.slice(1, -1)) };
    if (FORMULA_NUM_RE.test(s)) return { num: formulaNumber(s) };
    if (FORMULA_ID_RE.test(s) || (/^[\w-]{8,}$/.test(s) && !/^\d+$/.test(s))) return { id: s };   // UUID (ou id antigo)
    throw new FormulaError('syntax');
  },

  // [2,3] · [,3] · [2] · [2:-1, 3] · [HP] · ['nome com, vírgula']
  _sel(s) {
    const t = s.trim();
    const q = t.match(/^(['"])(.*)\1$/s);
    if (q) return { key: q[2] };
    const parts = this._split(t);
    const pos = p => {
      if (!p) return null;
      const m = p.match(/^([+-]?\d+)(?::([+-]?\d+))?$/);
      return m ? { from: +m[1], to: m[2] === undefined ? +m[1] : +m[2] } : undefined;
    };
    if (parts.length === 1) {
      const r = pos(parts[0]);
      return r === undefined ? { key: parts[0] } : { rows: r, cols: null };
    }
    if (parts.length !== 2) throw new FormulaError('syntax');
    const rows = pos(parts[0]), cols = pos(parts[1]);
    if (rows === undefined || cols === undefined) throw new FormulaError('syntax');
    return { rows, cols };
  },

  // → { fn, refs: [{ id, sel, label, num }] }
  parse(inner) {
    const s = inner.trim();
    const call = s.match(/^([A-Za-z]+)\s*\((.*)\)$/s);
    if (call) {
      const fn = call[1].toUpperCase();
      if (!FORMULA_FUNCS.includes(fn)) throw new FormulaError('fn');
      const tokens = this._split(call[2]).filter(Boolean).map(x => this._token(x));
      const refs = [];
      for (const tk of tokens) {
        if (tk.sel && refs.length && refs.at(-1).id && !refs.at(-1).sel) refs.at(-1).sel = tk.sel;
        else if (tk.label) throw new FormulaError('syntax');
        else refs.push({ ...tk });
      }
      if (!refs.length) throw new FormulaError('syntax');
      return { fn, refs };
    }
    const tokens = this._split(s).map(x => this._token(x));
    const [a, b] = tokens;
    if (tokens.length > 2 || !a || a.num !== undefined || a.label !== undefined) throw new FormulaError('syntax');
    if (a.sel) { if (b) throw new FormulaError('syntax'); return { fn: null, refs: [{ sel: a.sel }] }; }
    if (b && b.num !== undefined) throw new FormulaError('syntax');
    return { fn: null, refs: [{ id: a.id, sel: b?.sel, label: b?.label }] };
  },

  /* ── Avaliação ───────────────────────────────────────────── */
  // Chave do lugar onde um texto está (para achar autorreferência)
  _where(ctx) {
    if (!ctx.self) return 'doc';
    if (ctx.row) return `${ctx.self.id}:${ctx.row.id}:${ctx.col}`;
    if (ctx.key != null) return `${ctx.self.id}:k:${ctx.key}:${ctx.col ?? 1}`;
    return `${ctx.self.id}:text`;
  },

  // Linhas de um alvo em forma de tabela: { rows: [{ key, cells: [valor, …], ctx(c) }], names, kind(c) }
  _grid(node) {
    switch (node.type) {
      case 'table': {
        const names = node.header?.[0]?.data || [];
        return {
          names,
          kind: c => node.columns?.[c]?.kind ?? node.dataKind ?? null,
          rows: (node.rows || []).map(r => ({ key: r.id, cells: names.map((_, c) => r.data?.[c] ?? ''), ctx: c => ({ self: node, row: r, col: c }) })),
        };
      }
      case 'summary':
        return { names: [], kind: () => null, rows: (node.rows || []).map(r => ({ key: r.id, cells: [r.data?.[0] ?? '', r.data?.[1] ?? ''], ctx: c => ({ self: node, row: r, col: c }) })) };
      case 'keyvalue':
        return { names: [], kind: () => null, keyed: true, rows: Object.entries(node.data || {}).map(([k, v]) => ({ key: k, cells: [k, v ?? ''], ctx: c => ({ self: node, key: k, col: c }) })) };
      case 'checklist':
        return { names: [], kind: () => null, rows: (node.items || []).map(x => ({ key: x.id, cells: [x.text ?? '', x.done ? '✓' : ''], ctx: () => ({ self: node }) })) };
    }
    return null;
  },

  // Posição da fórmula (1 = primeira, 0/vazio = todas, negativa = do fim) → índices
  _range(r, n) {
    if (!r || (r.from === 0 && r.to === 0)) return [...Array(n).keys()];
    const at = i => i > 0 ? i - 1 : i < 0 ? n + i : null;
    let a = at(r.from), b = at(r.to);
    if (a === null) a = 0;
    if (b === null) b = n - 1;
    if (a > b) [a, b] = [b, a];
    if (a < 0 || b >= n) throw new FormulaError('range');
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  },

  // Texto de um campo, com as fórmulas dele já resolvidas (para quem o cita). Um ciclo sobe até a fórmula
  // de fora (⟳); outro erro lá dentro só aparece como texto (quem cita continua funcionando).
  _text(raw, ctx, seen) {
    const s = String(raw ?? '');
    if (!this.has(s)) return s;
    const here = this._where(ctx);
    if (seen.has(here)) throw new FormulaError('cycle');
    seen.add(here);
    try { return this.plain(s, ctx, seen, true); }
    catch (err) {
      if (!(err instanceof FormulaError) || err.kind === 'cycle') throw err;
      return this.plain(s, ctx, seen);
    } finally { seen.delete(here); }
  },

  // Texto que representa um nó num link (título, texto, legenda…)
  _label(node, blocks, seen) {
    const raw = node.title ?? (typeof node.content === 'string' ? node.content : null) ?? node.text ?? node.caption
      ?? (node.data && Array.isArray(node.data) ? node.data.join(' · ') : null) ?? (node.src ? mediaName(node.src) : '');
    const s = this._text(raw, { blocks, self: node }, seen).replace(/\s+/g, ' ').trim();
    return (s.length > FORMULA_MAX_TEXT ? s.slice(0, FORMULA_MAX_TEXT - 1) + '…' : s) || TYPES[node.type]?.label || '';
  },

  // Valores de uma referência → { values, kinds, id }
  _values(ref, ctx, seen) {
    if (ref.num !== undefined) return { values: [String(ref.num)], nums: [ref.num], kinds: [null] };
    const target = ref.id ? findNode(ctx.blocks, ref.id) : ctx.self;
    if (!target) throw new FormulaError(ref.id ? 'notFound' : 'noSelf');
    if (!ref.sel) return { values: [this._label(target, ctx.blocks, seen)], kinds: [null], target };
    const grid = this._grid(target);
    if (!grid) throw new FormulaError('sel');

    let cells = [];   // [linha, coluna]
    if (ref.sel.key != null) {
      const k = ref.sel.key.trim(), low = k.toLowerCase();
      if (grid.keyed) {
        let i = grid.rows.findIndex(r => r.key === k);
        if (i < 0) i = grid.rows.findIndex(r => r.key.trim().toLowerCase() === low);
        if (i < 0) throw new FormulaError('range');
        cells = [[i, 1]];
      } else {
        const c = grid.names.findIndex(n => String(n).trim().toLowerCase() === low);
        if (c < 0) throw new FormulaError('range');
        cells = grid.rows.map((_, i) => [i, c]);
      }
    } else {
      const ncols = grid.rows[0]?.cells.length ?? grid.names.length;
      const rows = this._range(ref.sel.rows, grid.rows.length);
      const cols = ref.sel.cols ? this._range(ref.sel.cols, ncols) : [...Array(ncols).keys()];
      rows.forEach(r => cols.forEach(c => cells.push([r, c])));
    }
    const values = cells.map(([r, c]) => {
      const row = grid.rows[r];
      const cctx = { blocks: ctx.blocks, ...row.ctx(c) };
      const here = this._where(cctx);
      if (seen.has(here)) throw new FormulaError('cycle');
      return this._text(row.cells[c], cctx, seen);
    });
    return { values, kinds: cells.map(([, c]) => grid.kind(c)), target };
  },

  // Uma fórmula → { kind: 'link' | 'value' | 'error', text, id, error }
  // nested: dentro de outra fórmula (o erro sobe para ela, em vez de virar texto)
  evaluate(inner, ctx, seen = new Set([this._where(ctx)]), nested = false) {
    try {
      const f = this.parse(inner);
      if (!f.fn) {
        const ref = f.refs[0];
        const { values, target } = this._values(ref, ctx, seen);
        const text = ref.label ?? (values.join(', ') || '—');
        return ref.id ? { kind: 'link', text, id: target.id } : { kind: 'value', text };
      }
      const got = f.refs.map(r => this._values(r, ctx, seen));
      const values = got.flatMap(g => g.values), kinds = got.flatMap(g => g.kinds);
      return { kind: 'value', text: formulaCalc(f.fn, values, kinds) };
    } catch (err) {
      if (!(err instanceof FormulaError) || nested) throw err;
      return { kind: 'error', error: err.kind, text: `f{${inner}}` };
    }
  },

  _each(text, fn) {
    const s = String(text ?? '');
    let out = '', last = 0;
    for (const m of s.matchAll(FORMULA_RE)) {
      out += fn(null, s.slice(last, m.index)) + fn(m[1], m[0]);
      last = m.index + m[0].length;
    }
    return out + fn(null, s.slice(last));
  },

  // Texto puro: cada fórmula vira o texto que ela representa (erro: a própria fórmula)
  plain(text, ctx = {}, seen, nested = false) {
    ctx = { blocks: Docs.current?.blocks || [], ...ctx };
    return this._each(text, (inner, s) => inner === null ? s : this.evaluate(inner, ctx, seen, nested).text);
  },

  // HTML da tela: link, valor ou erro (a sintaxe só aparece na edição)
  html(text, ctx = {}) {
    ctx = { blocks: Docs.current?.blocks || [], ...ctx };
    return this._each(text, (inner, s) => {
      if (inner === null) return esc(s);
      const r = this.evaluate(inner, ctx);
      const src = `f{${inner}}`;
      if (r.kind === 'link') return `<a class="f-link" href="#" data-target="${esc(r.id)}" title="${esc(src)}">${esc(r.text)}</a>`;
      if (r.kind === 'value') return `<span class="f-value" title="${esc(src)}">${esc(r.text)}</span>`;
      return `<span class="f-invalid${r.error === 'cycle' ? ' f-cycle' : ''}" title="${esc(t(`formula.err.${r.error}`))}">${esc((r.error === 'cycle' ? '⟳ ' : '⚠ ') + src)}</span>`;
    });
  },

  // Erros das fórmulas de um texto (para o sinal da sidebar)
  errors(text, ctx) {
    const out = [];
    ctx = { blocks: Docs.current?.blocks || [], ...ctx };
    for (const m of String(text ?? '').matchAll(FORMULA_RE)) {
      const r = this.evaluate(m[1], ctx);
      if (r.kind === 'error') out.push(r.error);
    }
    return out;
  },

  // IDs citados pelas fórmulas de um texto
  refs(text) {
    const ids = [];
    for (const m of String(text ?? '').matchAll(FORMULA_RE)) for (const id of m[1].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []) ids.push(id);
    return ids;
  },

  // Troca IDs dentro das fórmulas (duplicar: o que aponta para dentro da cópia passa a apontar para a cópia)
  remap(text, map) {
    if (!this.has(text)) return text;
    return String(text).replace(FORMULA_RE, whole => whole.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => map.get(id) ?? id));
  },

  // Link já resolvido, com o texto como rótulo (cópia de exportação)
  linkFormula: (id, text) => `\`f{${id}, '${String(text).replace(/'/g, '’').replace(/`/g, '´')}'}\``,

  // Cópia do documento para exportar: fórmulas de valor e funções viram o texto; links ficam como
  // `f{UUID, 'texto'}` (o exportador decide se vira link interno ou texto)
  forExport(rec) {
    const copy = { ...rec, name: rec.name, blocks: structuredClone(rec.blocks) };
    const seen = () => new Set();
    copy.name = this.plain(copy.name, { blocks: copy.blocks });
    eachText(copy.blocks, (text, ctx) => {
      if (!this.has(text)) return;
      const full = { blocks: copy.blocks, ...ctx };
      return this._each(text, (inner, s) => {
        if (inner === null) return s;
        const r = this.evaluate(inner, full, new Set([this._where(full)]));
        return r.kind === 'link' ? this.linkFormula(r.id, r.text) : r.text;
      });
    });
    return copy;
  },
};

/* ── Números e funções ─────────────────────────────────────── */
// "R$ 1.234,56" · "1,5" · "10%" · "1.234" → número (NaN se não for número)
function formulaNumber(v) {
  let s = String(v ?? '').replace(/R\$|US\$|\$|€|£|%|\s/g, '');
  if (!s || !/^[+-]?[\d.,]+$/.test(s)) return NaN;
  const sign = s.startsWith('-') ? -1 : 1;
  s = s.replace(/^[+-]/, '');
  const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (last < 0) return sign * Number(s);
  const seps = s.match(/[.,]/g).length, dec = s.length - last - 1;
  const decimal = (s.includes(',') && s.includes('.')) || dec !== 3 || (seps === 1 && s[last] === ',');
  return sign * (decimal ? Number(s.slice(0, last).replace(/[.,]/g, '') + '.' + s.slice(last + 1)) : Number(s.replace(/[.,]/g, '')));
}

function formulaCalc(fn, values, kinds) {
  if (fn === 'COUNT') return String(values.filter(v => String(v).trim()).length);
  const nums = values.map(formulaNumber).filter(Number.isFinite);
  if (!nums.length) return '—';
  const n = fn === 'SUM' ? nums.reduce((a, b) => a + b, 0)
    : fn === 'AVG' ? nums.reduce((a, b) => a + b, 0) / nums.length
    : fn === 'MIN' ? Math.min(...nums) : Math.max(...nums);
  const known = [...new Set(kinds.filter(Boolean))];
  const kind = known.length === 1 ? known[0] : null;
  const sym = kind === 'money' ? (values.map(v => String(v).match(/R\$|US\$|\$|€|£/)?.[0]).find(Boolean) || (LANG === 'en' ? '$' : 'R$')) : '';
  return formulaFormat(n, kind, sym, fn);
}

function formulaFormat(n, kind, sym, fn) {
  const loc = LANG === 'en' ? 'en-US' : 'pt-BR';
  const opts = kind === 'money' ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : kind === 'integer' && fn !== 'AVG' ? { maximumFractionDigits: 0 }
    : { maximumFractionDigits: 2 };
  const s = n.toLocaleString(loc, opts);
  return kind === 'money' ? `${sym} ${s}` : kind === 'percent' ? `${s}%` : s;
}

/* ── Textos do documento ───────────────────────────────────── */
// Campos de texto do próprio nó (sem descer nos filhos), com o contexto de cada um.
// fn(texto, ctx) → texto novo (ou undefined para não mudar)
function ownTexts(n, fn) {
  const set = (obj, k, ctx) => { if (typeof obj[k] !== 'string') return; const v = fn(obj[k], ctx); if (v !== undefined && v !== obj[k]) obj[k] = v; };
  ['title', 'text', 'caption'].forEach(k => set(n, k, { self: n }));
  if (typeof n.content === 'string') set(n, 'content', { self: n });
  if (n.type === 'keyvalue' && n.data && typeof n.data === 'object') {
    let changed = false;
    const entries = Object.entries(n.data).map(([k, v]) => {
      const nk = fn(k, { self: n, key: k, col: 0 }) ?? k;
      const nv = typeof v === 'string' ? fn(v, { self: n, key: k, col: 1 }) ?? v : v;
      if (nk !== k || nv !== v) changed = true;
      return [nk, nv];
    });
    if (changed) n.data = Object.fromEntries(entries);
  }
  for (const r of [...(n.header || []), ...(n.rows || [])]) (r.data || []).forEach((v, c) => {
    if (typeof v !== 'string') return;
    const nv = fn(v, { self: n, row: r, col: c });
    if (nv !== undefined && nv !== v) r.data[c] = nv;
  });
  (n.items || []).forEach(x => { if (typeof x.text === 'string') { const v = fn(x.text, { self: n }); if (v !== undefined && v !== x.text) x.text = v; } });
  (n.more || []).forEach(m => { if (m && typeof m.caption === 'string') { const v = fn(m.caption, { self: n }); if (v !== undefined && v !== m.caption) m.caption = v; } });
}

// Todos os campos de texto de uma lista de nós (e dos filhos)
function eachText(nodes, fn) {
  walkNodes(nodes, n => { if (n.type) ownTexts(n, fn); });
}

// Valor que uma célula de tabela mostra (com fórmula: o calculado) — é o que o tipo de dado confere (15d)
function cellShown(table, row, col, value = row?.data?.[col]) {
  return Formula.has(value) ? Formula.plain(value, { blocks: Docs.current?.blocks || [], self: table, row, col }) : value;
}

// Texto puro com fórmulas (sidebar, exportações): mantém o nome antigo usado pelo resto do app
function plainText(text, blocks, ctx = {}) {
  return Formula.has(text) ? Formula.plain(text, { blocks, ...ctx }) : String(text ?? '');
}

// Quantas fórmulas fora de `node` citam ele ou algo dentro dele (aviso ao excluir, 17f)
function citationsOf(blocks, node) {
  const inside = new Set();
  walkNodes([node], n => { if (n.id) inside.add(n.id); });
  let count = 0;
  walkNodes(blocks, n => {
    if (!n.type || inside.has(n.id)) return;
    ownTexts(n, text => { count += Formula.refs(text).filter(id => inside.has(id)).length; });
  });
  return count;
}

/* ── Inserir sem digitar UUID (17c) ────────────────────────────
   Num campo em edição, digitar `f{ abre a busca pelos títulos e textos do documento; escolher insere a
   fórmula pronta. Chave-valor: cada chave; tabela: cada coluna (para as funções). ↑ ↓ escolhem,
   Enter/Tab inserem, Esc fecha. Precisa ser ligado antes do teclado do campo (para ficar com as teclas). */
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function formulaTargets() {
  const blocks = Docs.current?.blocks || [];
  const out = [];
  walkNodes(blocks, n => {
    if (!n.type || n.type === 'gridcol') return;
    const label = Formula._label(n, blocks, new Set());
    const tag = TYPES[n.type]?.tag || n.type;
    out.push({ tag, text: label, insert: `\`f{${n.id}}\`` });
    if (n.type === 'keyvalue') Object.keys(n.data || {}).forEach(k => out.push({ tag, text: `${label} › ${k}`, insert: `\`f{${n.id}, [${k}]}\`` }));
    if (n.type === 'table') (n.header?.[0]?.data || []).forEach((h, c) => out.push({ tag, text: `${label} › ${plainText(h, blocks) || '#' + (c + 1)}`, insert: `\`f{${n.id}, [,${c + 1}]}\`` }));
  });
  return out;
}

Formula.attachPicker = function (input) {
  let box = null, items = [], active = 0, start = -1;
  const close = () => { box?.remove(); box = null; start = -1; };
  const choose = i => {
    const it = items[i];
    if (!it) return close();
    const caret = input.selectionStart;
    input.value = input.value.slice(0, start) + it.insert + input.value.slice(caret);
    const at = start + it.insert.length;
    input.setSelectionRange(at, at);
    close();
  };
  const draw = () => {
    box.innerHTML = items.length
      ? items.map((it, i) => `<div class="f-picker-item${i === active ? ' active' : ''}" data-i="${i}"><span class="f-picker-tag">${esc(it.tag)}</span><span class="f-picker-text">${esc(it.text)}</span></div>`).join('')
      : `<div class="f-picker-empty">${esc(t('formula.pickNone'))}</div>`;
    box.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const open = query => {
    const q = fold(query.trim());
    items = formulaTargets().filter(x => !q || fold(x.text).includes(q)).slice(0, 30);
    active = Math.min(active, Math.max(0, items.length - 1));
    if (!box) {
      box = document.createElement('div');
      box.className = 'f-picker';
      box.addEventListener('mousedown', e => {   // mousedown: antes do blur do campo
        const el = e.target.closest('.f-picker-item');
        e.preventDefault();
        if (el) choose(+el.dataset.i);
      });
      document.body.appendChild(box);
    }
    draw();
    // Embaixo do campo; sem espaço, logo acima dele
    const r = input.getBoundingClientRect(), h = box.offsetHeight;
    box.style.left = `${Math.max(4, Math.min(r.left, innerWidth - box.offsetWidth - 4))}px`;
    box.style.top = `${r.bottom + 2 + h < innerHeight ? r.bottom + 2 : Math.max(4, r.top - 2 - h)}px`;
  };
  input.addEventListener('input', () => {
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/`f\{([^`{}[\],'"]*)$/);
    if (!m) return close();
    start = m.index;
    open(m[1]);
  });
  input.addEventListener('keydown', e => {
    if (!box) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { stop(); active = (active + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === 'ArrowUp') { stop(); active = (active - 1 + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { stop(); choose(active); }
    else if (e.key === 'Escape') { stop(); close(); }
  });
  input.addEventListener('blur', close);
};

// Clique num link de fórmula → rola até o elemento e pisca
document.addEventListener('click', e => {
  const link = e.target.closest('.f-link');
  if (!link || !link.closest('#editor-main, .sidebar')) return;
  e.preventDefault();
  const el = document.querySelector(`#editor-main [data-node-id="${CSS.escape(link.dataset.target)}"]`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); flashEl(el); }
});
