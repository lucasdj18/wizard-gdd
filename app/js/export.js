/* ============================================================
   export.js — Preview e exportação (fase 5)

   Cada formato é um módulo em EXPORTERS:
     { id, label, ext, mime, build(rec) → Blob | string, preview(rec, el) }
   Para criar um formato novo basta acrescentar um módulo; os outros não mudam.

   JSON é o formato nativo. PDF, TXT, Markdown, DOCX e o formulário
   HTML são derivados do documento.
   ============================================================ */

/* ── Fórmulas nas exportações (fase 17) ──
   Cada exportação trabalha numa cópia (Formula.forExport): funções e valores já viram texto e os
   links ficam como `f{UUID, 'texto'}`; plainText (formula.js) dá o texto, e HTML/Markdown podem
   fazer deles links internos. */

// Percorre o documento em ordem de leitura, chamando visit[tipo](nó, profundidade)
// Tópicos podem ter tópicos (depth = nível). Grid: grid → gridCol/gridColEnd por coluna → gridEnd;
// quem não trata o grid recebe os itens das colunas em sequência.
// Capítulo (15a): chapter → os contêineres dele → chapterEnd. Destaque (15b): highlight(n) antes do nó.
function walkDocument(rec, visit) {
  const items = (list, depth) => (list || []).forEach(n => {
    if (n.highlight) visit.highlight?.(n, depth);
    visit[n.type]?.(n, depth);
    if (n.type === 'topic') { items(n.content, depth + 1); visit.topicEnd?.(n, depth); }
    if (n.type === 'grid') {
      (n.content || []).forEach((col, i) => { visit.gridCol?.(col, i, n); items(col.content, depth); visit.gridColEnd?.(col, i, n); });
      visit.gridEnd?.(n, depth);
    }
  });
  const block = b => {
    if (b.type === 'grid') return items([b], 0);   // grid fora dos contêineres
    if (b.highlight) visit.highlight?.(b, 0);
    visit.block?.(b); items(b.content, 0); visit.blockEnd?.(b);
  };
  visit.doc?.(rec);
  (rec.blocks || []).forEach(b => {
    if (b.type !== 'chapter') return block(b);
    visit.chapter?.(b); (b.content || []).forEach(block); visit.chapterEnd?.(b);
  });
}

const highlightLabel = n => t(`hl.label.${n.highlight}`);   // "⚠ ALERTA", "? DÚVIDA", "🔒 SPOILER"

// Imagens visíveis de um item imagem (a galeria mostra linhas × colunas; a primeira é o próprio item)
const galleryImages = n => Array.from({ length: gallerySize(n) }, (_, slot) => ({ slot, ...(slot ? n.more?.[slot - 1] : n) }));
const imageKey = (n, slot) => slot ? `${n.id}#${slot}` : n.id;
// Divisor em texto: largura proporcional a 60 colunas, com o desenho escolhido
const textRule = n => ({ solid: '─', dashed: '╌', dotted: '┈', double: '═' })[n.style || 'solid'].repeat(Math.round(60 * (n.width || 100) / 100));
const spacerLines = n => ({ sm: 1, md: 1, lg: 2, xl: 3 })[n.size || 'md'];
const durText = n => n.duration ? ` · ${Math.floor(n.duration / 60)}:${String(n.duration % 60).padStart(2, '0')}` : '';

// Linhas do sumário e alinhamento de cada coluna (padrão: esquerda, direita)
const summaryRows = n => (n.rows || []).map(r => [r.data?.[0] ?? '', r.data?.[1] ?? '']);
const summaryAlign = (n, c) => n.columns?.[c]?.align || ['left', 'right'][c];

const kvEntries = n => Object.entries(n.data || {});
const tableRows = n => [n.header?.[0]?.data || [], ...(n.rows || []).map(r => r.data || [])];

/* ============================================================
   TXT
   ============================================================ */
function buildTXT(rec) {
  rec = Formula.forExport(rec);
  const out = [], P = s => plainText(s, rec.blocks);
  const line = (s, depth = 0) => out.push('  '.repeat(depth) + s);
  walkDocument(rec, {
    doc:        r => { const n = P(r.name); out.push(n.toUpperCase(), '='.repeat(n.length), ''); },
    chapter:    c => { const n = P(c.title).toUpperCase(); out.push('', '', n, '═'.repeat(n.length)); },
    highlight:  (n, d) => line(`[${highlightLabel(n)}]`, d),
    block:      b => { const n = P(b.title); out.push('', n, '-'.repeat(n.length)); },
    topic:      (n, d) => { line('', d); line(`[${P(n.title)}]`, d); },
    description:(n, d) => { line(P(n.content), d); line('', d); },
    text:       (n, d) => { P(n.content).split('\n').forEach(l => line(l, d)); line('', d); },
    obs:        (n, d) => line(`${t('type.obs')}: ${P(n.content)}`, d),
    item:       (n, d) => line(`${itemMarker(n)} ${P(n.text)}`, d),
    keyvalue:   (n, d) => { line(`${P(n.title)}:`, d); kvEntries(n).forEach(([k, v]) => line(`  ${P(k)}: ${P(v)}`, d)); line('', d); },
    table:      (n, d) => {
      const rows = tableRows(n).map(r => r.map(P));
      const w = rows[0].map((_, c) => Math.max(...rows.map(r => (r[c] ?? '').length)));
      const fmt = r => w.map((wc, c) => (r[c] ?? '').padEnd(wc)).join(' | ');
      line(`${P(n.title)}:`, d);
      rows.forEach((r, i) => { line(fmt(r), d + 1); if (i === 0) line(w.map(x => '-'.repeat(x)).join('-+-'), d + 1); });
      line('', d);
    },
    checklist:  (n, d) => { line(`${P(n.title)}:`, d); (n.items || []).forEach(x => line(`  [${x.done ? 'x' : ' '}] ${P(x.text)}`, d)); line('', d); },
    summary:    (n, d) => {   // colunas alinhadas como na tela (à direita = encostado à direita)
      const rows = summaryRows(n).map(r => r.map(P));
      const w = [0, 1].map(c => Math.max(0, ...rows.map(r => r[c].length)));
      const pad = (s, c) => summaryAlign(n, c) === 'right' ? s.padStart(w[c]) : summaryAlign(n, c) === 'center' ? s.padStart(Math.floor((w[c] + s.length) / 2)).padEnd(w[c]) : s.padEnd(w[c]);
      line(`${P(n.title)}:`, d);
      rows.forEach(r => line(`${pad(r[0], 0)}  ${pad(r[1], 1)}`.trimEnd(), d + 1));
      line('', d);
    },
    image:      (n, d) => {
      galleryImages(n).forEach(g => line(`[${t('type.image')}: ${mediaName(g.src) || '—'}]`, d));
      if (n.caption) line(P(n.caption), d);
      line('', d);
    },
    video:      (n, d) => { line(`[${t('type.video')}: ${mediaName(n.src) || '—'}]${n.caption ? ' ' + P(n.caption) : ''}`, d); line('', d); },
    audio:      (n, d) => { line(`[♪ ${t('type.audio')}: ${mediaName(n.src) || '—'}${durText(n)}]${n.caption ? ' ' + P(n.caption) : ''}`, d); line('', d); },
    divider:    (n, d) => { line('', d); line(textRule(n), d); line('', d); },
    spacer:     (n, d) => { for (let i = 0; i < spacerLines(n); i++) line('', d); },
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ============================================================
   MARKDOWN
   ============================================================ */
// Links internos (17g): a fórmula-link vira um link para o elemento citado; só os citados ganham âncora "w-<id>".
// Linhas, tarefas e colunas do grid usam a âncora do nó de cima.
function exportLinks(rec) {
  const owner = new Map();
  walkNodes(rec.blocks, (n, parent) => { if (n.id) owner.set(n.id, n.type && n.type !== 'gridcol' ? n.id : parent?.id ?? n.id); });
  const cited = new Set();
  const cite = text => Formula.refs(text).forEach(id => owner.has(id) && cited.add(owner.get(id)));
  eachText(rec.blocks, cite);
  cite(rec.name);
  return {
    anchor: n => n?.id && cited.has(n.id) ? `w-${n.id}` : null,
    // escape: o que fazer com o texto comum · link(âncora, texto já escapado)
    text: (s, escape, link) => Formula._each(s, (inner, seg) => {
      if (inner === null) return escape(seg);
      const r = Formula.evaluate(inner, { blocks: rec.blocks });
      return r.kind === 'link' && owner.has(r.id) ? link(`w-${owner.get(r.id)}`, escape(r.text)) : escape(r.text);
    }),
  };
}

function buildMarkdown(rec) {
  rec = Formula.forExport(rec);
  const out = [], P = s => plainText(s, rec.blocks);
  const X = exportLinks(rec);
  const L = s => X.text(s, x => x, (to, x) => `[${x.replace(/[[\]]/g, '\\$&')}](#${to})`);   // texto com links
  const A = n => X.anchor(n) ? `<a id="${X.anchor(n)}"></a>` : '';                           // âncora do citado
  const cell = s => L(s).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  walkDocument(rec, {
    doc:        r => out.push(`# ${L(r.name)}`, ''),
    chapter:    c => out.push('', `# ${A(c)}${L(c.title)}`, ''),   // capítulo no mesmo nível do nome; contêineres continuam ##
    highlight:  n => out.push('', `**${highlightLabel(n)}**`, ''),
    block:      b => out.push(`## ${A(b)}${L(b.title)}`, ''),
    topic:      (n, d) => out.push(`${'#'.repeat(Math.min(6, 3 + d))} ${A(n)}${L(n.title)}`, ''),   // ### e um # a mais por nível
    description:n => out.push(A(n) + L(n.content), ''),
    text:       n => out.push(A(n) + L(n.content), ''),
    obs:        n => out.push(`> ${A(n)}**${t('type.obs')}:** ${L(n.content).replace(/\n/g, '\n> ')}`, ''),
    // Marcador padrão (•) é o "-" da lista; os outros entram no início do texto (escapados: > - + # viram sintaxe)
    item:       n => out.push(`- ${A(n)}${n.marker ? itemMarker(n).replace(/^[\\`*_{}\[\]()#+\-.!>|<$@?]$/, '\\$&') + ' ' : ''}${L(n.text)}`),
    keyvalue:   n => { out.push('', `**${A(n)}${L(n.title)}**`, ''); kvEntries(n).forEach(([k, v]) => out.push(`- **${L(k)}:** ${L(v)}`)); out.push(''); },
    table:      n => {
      const [head, ...rows] = tableRows(n);
      const mdAlign = c => ({ center: ' :---: ', right: ' ---: ' })[n.columns?.[c]?.align] || ' --- ';   // alinhamento da coluna (11c)
      out.push('', `**${A(n)}${L(n.title)}**`, '', `| ${head.map(cell).join(' | ')} |`, `|${head.map((_, c) => mdAlign(c)).join('|')}|`);
      rows.forEach(r => out.push(`| ${head.map((_, c) => cell(r[c] ?? '')).join(' | ')} |`));
      out.push('');
    },
    checklist:  n => { out.push('', `**${A(n)}${L(n.title)}**`, ''); (n.items || []).forEach(x => out.push(`- [${x.done ? 'x' : ' '}] ${L(x.text)}`)); out.push(''); },
    summary:    n => {   // tabela de 2 colunas com o alinhamento de cada coluna
      const al = c => ({ left: ' :--- ', center: ' :---: ', right: ' ---: ' })[summaryAlign(n, c)];
      out.push('', `**${A(n)}${L(n.title)}**`, '', '| | |', `|${al(0)}|${al(1)}|`);
      summaryRows(n).forEach(([a, b]) => out.push(`| ${cell(a)} | ${cell(b)} |`));
      out.push('');
    },
    image:      n => {
      const imgs = galleryImages(n).filter(g => g.src);
      if (imgs.length) out.push('', A(n) + imgs.map(g => `![${P(n.caption).replace(/[\[\]]/g, '')}](${g.src.replace(/ /g, '%20')})`).join(' '));
      if (n.caption) out.push('', `*${imgs.length ? '' : A(n)}${L(n.caption)}*`);
      out.push('');
    },
    video:      n => { if (n.src) out.push('', `${A(n)}[▶ ${P(n.caption) || mediaName(n.src)}](${n.src.replace(/ /g, '%20')})`); out.push(''); },
    audio:      n => { if (n.src) out.push('', `${A(n)}[♪ ${P(n.caption) || mediaName(n.src)}${durText(n)}](${n.src.replace(/ /g, '%20')})`); out.push(''); },
    divider:    () => out.push('', '---', ''),
    spacer:     n => { for (let i = 0; i < spacerLines(n); i++) out.push('&nbsp;', ''); },
    blockEnd:   () => out.push(''),
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ============================================================
   FORMULÁRIO HTML (um arquivo, CSS embutido, sem JavaScript)
   título → rótulo · texto → campo de texto · chave-valor → rótulo + campo
   tabela → grade de campos · checklist → caixas de marcar
   ============================================================ */
function buildFormHTML(rec) {
  rec = Formula.forExport(rec);
  const P = s => esc(plainText(s, rec.blocks));                                       // atributos e campos
  const X = exportLinks(rec);
  const L = s => X.text(s, esc, (to, x) => `<a href="#${to}">${x}</a>`);             // texto solto, com links (17g)
  const I = n => X.anchor(n) ? ` id="${X.anchor(n)}"` : '';                           // âncora do citado
  let uid = 0;
  const fid = () => `f${++uid}`;
  const parts = [];
  // Formatar/Configurar (cor do papel, fonte, tamanho, alinhamento) vira estilo no campo
  const fmtStyle = (...fmts) => {
    const f = Object.assign({}, ...fmts.filter(Boolean));
    const css = [f.color && `color:#${FORMAT_COLORS[f.color]}`, f.font && `font-family:${FORMAT_FONTS[f.font]},sans-serif`,
      f.size && `font-size:${FORMAT_SIZES[f.size]}em`, f.align && `text-align:${f.align}`].filter(Boolean).join(';');
    return css ? ` style="${css}"` : '';
  };
  const textField = (label, value, multiline, fmt, node) => {
    const id = fid();
    return `<div class="wz-field"${I(node)}><label for="${id}">${esc(label)}</label>${multiline
      ? `<textarea id="${id}" name="${id}" rows="${Math.max(2, String(value).split('\n').length)}"${fmtStyle(fmt)}>${value}</textarea>`
      : `<input id="${id}" name="${id}" type="text" value="${value}"${fmtStyle(fmt)}>`}</div>`;
  };

  walkDocument(rec, {
    chapter:    c => parts.push(`<h2 class="wz-chapter"${I(c)}>${L(c.title)}</h2>`),
    highlight:  n => parts.push(`<div class="wz-hl wz-hl-${n.highlight}">${esc(highlightLabel(n))}</div>`),
    block:      b => parts.push(`<fieldset class="wz-section"${I(b)}><legend>${L(b.title)}</legend>`),
    blockEnd:   () => parts.push('</fieldset>'),
    topic:      n => parts.push(`<fieldset class="wz-topic"${I(n)}><legend>${L(n.title)}</legend>`),
    topicEnd:   () => parts.push('</fieldset>'),
    description:n => parts.push(textField(t('type.description'), P(n.content), true, n.format, n)),
    text:       n => parts.push(textField(t('type.text'), P(n.content), true, n.format, n)),
    obs:        n => parts.push(textField(t('type.obs'), P(n.content), true, n.format, n)),
    item:       n => parts.push(textField(n.marker ? `${n.marker} ${t('type.item')}` : t('type.item'), P(n.text), false, n.format, n)),
    keyvalue:   n => {
      parts.push(`<div class="wz-group"${I(n)}><div class="wz-group-title">${L(n.title)}</div>`);
      kvEntries(n).forEach(([k, v]) => parts.push(textField(plainText(k, rec.blocks), P(v), false, { ...n.format, ...n.columns?.[1] })));
      parts.push('</div>');
    },
    table:      n => {
      const [head, ...rows] = tableRows(n);
      parts.push(`<div class="wz-group"${I(n)}><div class="wz-group-title">${L(n.title)}</div><table class="wz-table"><thead><tr>${head.map((h, c) => `<th scope="col"${fmtStyle(n.format, n.columns?.[c])}>${L(h)}</th>`).join('')}</tr></thead><tbody>`);
      rows.forEach(r => parts.push(`<tr>${head.map((h, c) => { const id = fid(); return `<td><input id="${id}" name="${id}" type="text" aria-label="${P(h)}" value="${P(r[c] ?? '')}"${fmtStyle(n.format, n.columns?.[c])}></td>`; }).join('')}</tr>`));
      parts.push('</tbody></table></div>');
    },
    summary:    n => {
      parts.push(`<div class="wz-group"${I(n)}><div class="wz-group-title">${L(n.title)}</div>`);
      summaryRows(n).forEach(([a, b]) => {
        const [ia, ib] = [fid(), fid()];
        parts.push(`<div class="wz-sum"><input id="${ia}" name="${ia}" type="text" aria-label="${P(n.title)}" value="${P(a)}"${fmtStyle(n.format, { align: summaryAlign(n, 0) }, n.columns?.[0])}>`
          + `<input id="${ib}" name="${ib}" type="text" aria-label="${P(a)}" value="${P(b)}"${fmtStyle(n.format, { align: summaryAlign(n, 1) }, n.columns?.[1])}></div>`);
      });
      parts.push('</div>');
    },
    grid:       n => parts.push(`<div class="wz-grid"${I(n)} style="grid-template-columns:repeat(${n.content.length},minmax(0,1fr))">`),
    gridCol:    () => parts.push('<div class="wz-grid-col">'),
    gridColEnd: () => parts.push('</div>'),
    gridEnd:    () => parts.push('</div>'),
    checklist:  n => {
      parts.push(`<fieldset class="wz-checks"${I(n)}><legend>${L(n.title)}</legend>`);
      (n.items || []).forEach(x => { const id = fid(); parts.push(`<label class="wz-check" for="${id}"><input id="${id}" name="${id}" type="checkbox"${x.done ? ' checked' : ''}> ${L(x.text)}</label>`); });
      parts.push('</fieldset>');
    },
    image: n => {
      const imgs = galleryImages(n).filter(g => g.src);
      if (!imgs.length) return;
      const tag = g => `<img src="${esc(g.src)}" alt="${P(n.caption)}"${g.width && g.height ? ` width="${g.width}" height="${g.height}"` : ''}>`;
      const body = gallerySize(n) > 1
        ? `<div class="wz-gallery" style="grid-template-columns:repeat(${n.gallery.cols},minmax(0,1fr))">${imgs.map(tag).join('')}</div>`
        : tag(imgs[0]);
      parts.push(`<figure class="wz-figure"${I(n)}>${body}${n.caption ? `<figcaption>${L(n.caption)}</figcaption>` : ''}</figure>`);
    },
    audio: n => {
      if (!n.src) return;
      parts.push(`<figure class="wz-figure"${I(n)}><audio src="${esc(n.src)}" controls preload="metadata"></audio>${n.caption ? `<figcaption>${L(n.caption)}</figcaption>` : ''}</figure>`);
    },
    divider: n => parts.push(`<hr class="wz-hr" style="width:${n.width || 100}%;border-top-style:${n.style || 'solid'}${n.style === 'double' ? ';border-top-width:4px' : ''}${n.format?.color ? `;border-top-color:#${FORMAT_COLORS[n.format.color]}` : ''}">`),
    spacer:  n => parts.push(`<div class="wz-spacer" style="height:${SPACER_SIZES[n.size || 'md']}px"></div>`),
    video: n => {
      if (!n.src) return;
      // controls é nativo do navegador: continua sem JavaScript
      parts.push(`<figure class="wz-figure"${I(n)}><video src="${esc(n.src)}" controls preload="metadata"${n.width && n.height ? ` width="${n.width}" height="${n.height}"` : ''}></video>${n.caption ? `<figcaption>${L(n.caption)}</figcaption>` : ''}</figure>`);
    },
  });

  return `<!DOCTYPE html>
<html lang="${LANG === 'pt' ? 'pt-BR' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${P(rec.name)}</title>
<style>
.wz-form{--wz-accent:#0a7a47;--wz-border:#d0d0d0;--wz-text:#1d1d1d;--wz-muted:#666;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--wz-text);max-width:760px;margin:24px auto;padding:0 16px;line-height:1.5}
.wz-form h1{font-size:1.6rem;margin:0 0 20px;padding-bottom:10px;border-bottom:2px solid var(--wz-accent)}
.wz-form fieldset{border:1px solid var(--wz-border);border-radius:6px;padding:14px 16px;margin:0 0 18px}
.wz-form legend{font-weight:700;padding:0 6px}
.wz-form .wz-section>legend{font-size:1.15rem;color:var(--wz-accent)}
.wz-form .wz-topic{border-style:dashed}
.wz-form .wz-field{display:flex;flex-direction:column;gap:4px;margin:0 0 12px}
.wz-form label{font-size:.85rem;color:var(--wz-muted)}
.wz-form input[type=text],.wz-form textarea{font:inherit;padding:8px 10px;border:1px solid var(--wz-border);border-radius:4px;width:100%;box-sizing:border-box}
.wz-form input[type=text]:focus,.wz-form textarea:focus{outline:2px solid var(--wz-accent);outline-offset:0;border-color:var(--wz-accent)}
.wz-form .wz-group{margin:0 0 14px}
.wz-form .wz-group-title{font-weight:600;margin:0 0 6px}
.wz-form .wz-table{border-collapse:collapse;width:100%}
.wz-form .wz-table th{text-align:left;font-size:.85rem;background:#f4f4f4;padding:6px 8px;border:1px solid var(--wz-border)}
.wz-form .wz-table td{padding:0;border:1px solid var(--wz-border)}
.wz-form .wz-table input[type=text]{border:0;border-radius:0}
.wz-form .wz-check{display:flex;align-items:center;gap:8px;color:var(--wz-text);font-size:1rem;margin:4px 0}
.wz-form input[type=checkbox]{width:18px;height:18px;accent-color:var(--wz-accent)}
.wz-form .wz-figure{margin:0 0 14px}
.wz-form .wz-figure img,.wz-form .wz-figure video{max-width:100%;height:auto;border-radius:4px;display:block}
.wz-form .wz-figure figcaption{font-size:.85rem;color:var(--wz-muted);margin-top:4px}
.wz-form .wz-sum{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 6px}
.wz-form .wz-gallery{display:grid;gap:8px}
.wz-form .wz-gallery img{width:100%;height:auto}
.wz-form .wz-figure audio{width:100%}
.wz-form .wz-hr{border:0;border-top:1px solid var(--wz-border);margin:14px auto}
.wz-form .wz-chapter{font-size:1.4rem;margin:28px 0 14px;padding-bottom:6px;border-bottom:3px double var(--wz-accent)}
.wz-form .wz-hl{display:inline-block;font-size:.75rem;font-weight:700;letter-spacing:1px;padding:2px 8px;border-radius:3px;margin:0 0 6px}
.wz-form .wz-hl-alert{background:#fff1e0;color:#b35c00}.wz-form .wz-hl-question{background:#e8f0ff;color:#0b5cad}.wz-form .wz-hl-spoiler{background:#eee;color:#555}
.wz-form .wz-grid{display:grid;gap:16px;margin:0 0 14px}
.wz-form .wz-grid-col{min-width:0}
@media (max-width:600px){.wz-form .wz-grid{grid-template-columns:1fr!important}}
</style>
</head>
<body>
<form class="wz-form" action="#">
<h1>${P(rec.name)}</h1>
${parts.join('\n')}
</form>
</body>
</html>
`;   // sem JavaScript: o formulário não envia nada
}

/* ============================================================
   DOCX — gerado aqui mesmo (ZIP sem compressão + XML), sem biblioteca
   ============================================================ */
const xmlEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// fmt: { color, size, font, align } do Formatar/Configurar (11b/11c); tamanho base 11 pt
function docxRuns(text, { bold = false, italic = false, fmt } = {}) {
  const props = (bold ? '<w:b/>' : '') + (italic ? '<w:i/>' : '')
    + (fmt?.font ? `<w:rFonts w:ascii="${FORMAT_FONTS[fmt.font]}" w:hAnsi="${FORMAT_FONTS[fmt.font]}" w:cs="${FORMAT_FONTS[fmt.font]}"/>` : '')
    + (fmt?.color ? `<w:color w:val="${FORMAT_COLORS[fmt.color]}"/>` : '')
    + (fmt?.size ? `<w:sz w:val="${Math.round(22 * FORMAT_SIZES[fmt.size])}"/>` : '');
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : '';
  return String(text ?? '').split('\n').map((line, i) =>
    `<w:r>${rPr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`).join('');
}
const DOCX_JC = { center: 'center', right: 'right' };
const docxP = (text, { style, bold, italic, indent, fmt } = {}) => {
  const jc = DOCX_JC[fmt?.align];
  const pPr = style || indent || jc ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${indent ? `<w:ind w:left="${indent}"/>` : ''}${jc ? `<w:jc w:val="${jc}"/>` : ''}</w:pPr>` : '';
  return `<w:p>${pPr}${docxRuns(text, { bold, italic, fmt })}</w:p>`;
};

// cols: formato por coluna (node.columns); o formato do item vale onde a coluna não define
function docxTable(rows, headerBold = true, { cols: colFmt = [], fmt, borders = true } = {}) {
  const cols = Math.max(1, ...rows.map(r => r.length));
  const border = borders ? 'w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"' : 'w:val="nil"';
  const cellFmt = c => ({ ...fmt, ...(colFmt[c] || {}) });
  const tr = (r, head) => `<w:tr>${Array.from({ length: cols }, (_, c) =>
    `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9000 / cols)}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>${docxP(r[c] ?? '', { bold: head && headerBold, fmt: cellFmt(c) })}</w:tc>`).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top ${border}/><w:left ${border}/><w:bottom ${border}/><w:right ${border}/><w:insideH ${border}/><w:insideV ${border}/></w:tblBorders></w:tblPr>`
    + `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${Math.floor(9000 / cols)}"/>`).join('')}</w:tblGrid>`
    + rows.map((r, i) => tr(r, i === 0)).join('') + '</w:tbl>' + docxP('');
}

// Grid: uma tabela sem bordas, uma célula por coluna com o conteúdo dela (trailing: parágrafo depois)
function docxGrid(cells, trailing = true) {
  const w = Math.floor(9000 / Math.max(1, cells.length)), nil = 'w:val="nil"';
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top ${nil}/><w:left ${nil}/><w:bottom ${nil}/><w:right ${nil}/><w:insideH ${nil}/><w:insideV ${nil}/></w:tblBorders></w:tblPr>`
    + `<w:tblGrid>${cells.map(() => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
    + `<w:tr>${cells.map(c => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${c}${c.endsWith('</w:p>') ? '' : docxP('')}</w:tc>`).join('')}</w:tr></w:tbl>` + (trailing ? docxP('') : '');
}

function buildDOCXDocument(rec, images = new Map()) {
  rec = Formula.forExport(rec);
  let body = [];
  const P = s => plainText(s, rec.blocks);
  const saved = [], cells = [];   // grid: cada coluna junta o seu conteúdo à parte
  walkDocument(rec, {
    doc:        r => body.push(docxP(P(r.name), { style: 'Title' })),
    chapter:    c => body.push(docxP(P(c.title), { style: 'Chapter' })),
    highlight:  n => body.push(docxP(highlightLabel(n), { bold: true, fmt: { color: { alert: 'orange', question: 'blue', spoiler: 'gray' }[n.highlight], size: 'sm' } })),
    block:      b => body.push(docxP(P(b.title), { style: 'Heading1' })),
    topic:      (n, d) => body.push(docxP(P(n.title), { style: `Heading${Math.min(4, 2 + d)}` })),   // tópico dentro de tópico: Título 3, 4
    grid:       () => cells.push([]),
    gridCol:    () => { saved.push(body); body = []; },
    gridColEnd: () => { cells.at(-1).push(body.join('')); body = saved.pop(); },
    gridEnd:    () => body.push(docxGrid(cells.pop())),
    summary:    n => {
      body.push(docxP(P(n.title), { bold: true, fmt: n.format }));
      const cols = [0, 1].map(c => ({ align: summaryAlign(n, c), ...(n.columns?.[c] || {}) }));
      body.push(docxTable(summaryRows(n).map(r => r.map(P)), false, { cols, fmt: n.format, borders: false }));
    },
    description:n => body.push(docxP(P(n.content), { fmt: n.format })),
    text:       n => body.push(docxP(P(n.content), { fmt: n.format })),
    obs:        n => body.push(docxP(`${t('type.obs')}: ${P(n.content)}`, { italic: true, indent: 360, fmt: n.format })),
    item:       n => body.push(docxP(`${itemMarker(n)} ${P(n.text)}`, { indent: 360, fmt: n.format })),
    keyvalue:   n => { body.push(docxP(P(n.title), { bold: true, fmt: n.format })); body.push(docxTable(kvEntries(n).map(([k, v]) => [P(k), P(v)]), false, { cols: n.columns || [], fmt: n.format })); },
    table:      n => { body.push(docxP(P(n.title), { bold: true, fmt: n.format })); body.push(docxTable(tableRows(n).map(r => r.map(P)), true, { cols: n.columns || [], fmt: n.format })); },
    checklist:  n => { body.push(docxP(P(n.title), { bold: true, fmt: n.format })); (n.items || []).forEach(x => body.push(docxP(`${x.done ? '☑' : '☐'} ${P(x.text)}`, { indent: 360, fmt: n.format }))); },
    image:      n => {
      const one = (key, src, maxW) => { const img = images.get(key); return img ? docxImage(img, n.align, maxW) : docxP(`[${t('type.image')}: ${mediaName(src) || '—'}]`, { italic: true }); };
      if (gallerySize(n) > 1) {   // galeria: tabela sem bordas, linhas × colunas
        const g = galleryImages(n), cols = n.gallery.cols, maxW = Math.floor(DOCX_MAX_W / cols) - 90000;
        const cells = r => Array.from({ length: cols }, (_, c) => g[r * cols + c]).map(x => x?.src ? one(imageKey(n, x.slot), x.src, maxW) : docxP(''));
        for (let r = 0; r < n.gallery.rows; r++) body.push(docxGrid(cells(r), r === n.gallery.rows - 1));   // as linhas ficam coladas
      } else {
        body.push(one(n.id, n.src));
      }
      if (n.caption) body.push(docxP(P(n.caption), { italic: true, fmt: { ...n.format, align: n.align === 'left' ? null : n.align ?? 'center' } }));
    },
    video:      n => {
      body.push(docxP(`▶ [${t('type.video')}: ${mediaName(n.src) || '—'}]`, { italic: true }));
      if (n.caption) body.push(docxP(P(n.caption), { italic: true, fmt: n.format }));
    },
    audio:      n => {
      body.push(docxP(`♪ [${t('type.audio')}: ${mediaName(n.src) || '—'}${durText(n)}]`, { italic: true }));
      if (n.caption) body.push(docxP(P(n.caption), { italic: true, fmt: n.format }));
    },
    divider:    n => {   // borda de baixo do parágrafo; a largura vira recuo dos dois lados
      const side = Math.round(9000 * (1 - (n.width || 100) / 100) / 2);
      const val = { solid: 'single', dashed: 'dashed', dotted: 'dotted', double: 'double' }[n.style || 'solid'];
      body.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="${val}" w:sz="${val === 'double' ? 4 : 6}" w:space="1" w:color="${n.format?.color ? FORMAT_COLORS[n.format.color] : 'BFBFBF'}"/></w:pBdr><w:ind w:left="${side}" w:right="${side}"/></w:pPr></w:p>`);
    },
    spacer:     n => body.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="${Math.round(SPACER_SIZES[n.size || 'md'] * 15)}"/></w:pPr></w:p>`),
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="850" w:header="425" w:footer="425" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="0A7A47"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="1F5FA8"/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Chapter"><w:name w:val="Capítulo"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="240"/><w:outlineLvl w:val="0"/><w:pBdr><w:bottom w:val="double" w:sz="6" w:space="4" w:color="0A7A47"/></w:pBdr></w:pPr><w:rPr><w:b/><w:caps/><w:color w:val="0A7A47"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="2E75C8"/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:i/><w:color w:val="2E75C8"/><w:sz w:val="22"/></w:rPr></w:style>
</w:styles>`;

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOCX_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

// Imagem embutida no DOCX (PNG, JPEG e GIF; os outros formatos viram texto)
const DOCX_IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' };
const EMU_PER_PX = 9525, DOCX_MAX_W = 6 * 914400;      // largura útil de ~6 polegadas

// align: como na tela (centro é o padrão; 11d)
function docxImage({ rid, n, width, height }, align, maxW = DOCX_MAX_W) {
  let cx = width * EMU_PER_PX, cy = height * EMU_PER_PX;
  if (cx > maxW) { cy = Math.round(cy * maxW / cx); cx = maxW; }
  const jc = align === 'left' ? '' : `<w:pPr><w:jc w:val="${align === 'right' ? 'right' : 'center'}"/></w:pPr>`;
  return `<w:p>${jc}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Imagem ${n}"/>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="imagem${n}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

async function buildDOCX(rec) {
  // Junta as imagens do documento que podem ser embutidas
  const images = new Map(), media = [];
  const nodes = [];
  // (galeria: cada quadro com imagem entra com a chave imageKey)
  walkNodes(rec.blocks, n => { if (n.type === 'image') galleryImages(n).forEach(g => g.src && nodes.push({ key: imageKey(n, g.slot), ...g })); });
  for (const img of nodes) {
    const file = typeof Media !== 'undefined' ? await Media.file(rec, img.src) : null;
    const ext = file && DOCX_IMAGE_EXT[file.type];
    if (!ext) continue;
    let { width, height } = img;
    if (!width || !height) ({ width, height } = await mediaDimensions(file, 'image'));
    if (!width || !height) continue;
    const n = media.length + 1;
    media.push({ path: `word/media/imagem${n}.${ext}`, bytes: new Uint8Array(await file.arrayBuffer()), rid: `rIdImg${n}`, target: `media/imagem${n}.${ext}` });
    images.set(img.key, { rid: `rIdImg${n}`, n, width, height });
  }

  const exts = [...new Set(media.map(m => m.path.split('.').pop()))];
  const contentTypes = DOCX_CONTENT_TYPES.replace('<Default Extension="xml"',
    exts.map(e => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('') + '<Default Extension="xml"');
  const docRels = DOCX_DOC_RELS.replace('</Relationships>',
    media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.target}"/>`).join('') + '</Relationships>');

  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', DOCX_RELS],
    ['word/_rels/document.xml.rels', docRels],
    ['word/document.xml', buildDOCXDocument(rec, images)],
    ['word/styles.xml', DOCX_STYLES],
    ...media.map(m => [m.path, m.bytes]),
  ], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

// ── ZIP mínimo (método "store", sem compressão) ──
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0; }
  return tbl;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files, mime = 'application/zip') {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    chunks.push(local.buffer, nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
    central.push(cen.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: mime });
}

/* ============================================================
   MÓDULOS DE EXPORTAÇÃO
   ============================================================ */
const EXPORTERS = [
  { id: 'json', label: 'JSON',     ext: 'json', mime: 'application/json', build: rec => serializeDocument(rec), preview: 'text' },
  { id: 'pdf',  label: 'PDF',      ext: 'pdf',                             build: null,                           preview: 'document', print: true },
  { id: 'txt',  label: 'TXT',      ext: 'txt',  mime: 'text/plain',       build: buildTXT,                       preview: 'text' },
  { id: 'md',   label: 'Markdown', ext: 'md',   mime: 'text/markdown',    build: buildMarkdown,                  preview: 'text' },
  { id: 'docx', label: 'DOCX',     ext: 'docx',                            build: buildDOCX,                      preview: 'document' },
  { id: 'html', get label() { return t('fmt.form'); }, ext: 'html', mime: 'text/html',     build: buildFormHTML,                  preview: 'frame' },
];

async function downloadExport(fmt) {
  const rec = Docs.current;
  if (fmt.print) return window.print();                       // PDF: "Salvar como PDF" na janela de impressão
  const out = await fmt.build(rec);
  const name = `${safeFileName(rec.name)}.${fmt.ext}`;
  if (out instanceof Blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else {
    downloadText(out, name, `${fmt.mime};charset=utf-8`);
  }
  toast(t('export.downloaded'), name);
}

/* ============================================================
   PREVIEW (5a): escolhe o formato → mostra o documento renderizado
   ============================================================ */
let previewFormat = null;

async function openPreview() {
  if (!Docs.current) return;
  const choice = await askChoice({
    title: t('preview.title'),
    message: t('export.pickMsg'),
    options: [
      ...EXPORTERS.map(f => ({ value: f.id, label: `${f.label} (.${f.ext})` })),
      { value: null, label: t('action.cancel') },
    ],
  });
  if (choice) showPreviewView(EXPORTERS.find(f => f.id === choice));
}

function showPreviewView(fmt) {
  previewFormat = fmt;
  const rec  = Docs.current;
  const main = document.getElementById('editor-main');
  let view = document.getElementById('preview-view');
  if (!view) {
    view = document.createElement('section');
    view.id = 'preview-view';
    main.after(view);
  }
  main.hidden = true;
  view.hidden = false;
  view.innerHTML = `
    <div class="pv-bar">
      <button class="pv-back">${esc(t('export.back'))}</button>
      <span class="pv-format">${esc(fmt.label)}</span>
      <button class="ls-btn-primary pv-download">${esc(fmt.print ? t('export.print') : t('export.download'))}</button>
    </div>
    <div class="pv-hint"></div>
    <div class="pv-body"></div>`;
  view.querySelector('.pv-back').addEventListener('click', closePreviewView);
  view.querySelector('.pv-download').addEventListener('click', () => downloadExport(fmt));

  const body = view.querySelector('.pv-body');
  const hint = view.querySelector('.pv-hint');
  if (fmt.preview === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'pv-text';
    pre.textContent = fmt.build(rec);
    body.appendChild(pre);
  } else if (fmt.preview === 'frame') {
    hint.textContent = t('export.htmlHint');
    const frame = document.createElement('iframe');
    frame.className = 'pv-frame';
    frame.setAttribute('sandbox', '');          // sem scripts; o formulário não envia nada
    frame.title = fmt.label;
    frame.srcdoc = fmt.build(rec);
    body.appendChild(frame);
  } else {
    // PDF / DOCX: o documento em "papel" (tema claro, largura A4); no PDF, com as quebras de página
    hint.textContent = fmt.print ? t('export.pdfHint') : t('export.docxHint');
    if (fmt.print) paginate();
    const paper = document.createElement('div');
    paper.className = 'pm pv-paper' + (fmt.print ? ' pv-pages' : '');
    const clone = main.cloneNode(true);
    clone.hidden = false;
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    clone.querySelectorAll('.editable').forEach(n => n.classList.remove('editable'));
    paper.appendChild(clone);
    body.appendChild(paper);
  }
  document.addEventListener('keydown', onPreviewKey);
  window.scrollTo(0, 0);
}

function closePreviewView() {
  previewFormat = null;
  document.removeEventListener('keydown', onPreviewKey);
  document.getElementById('preview-view')?.remove();
  document.getElementById('editor-main').hidden = false;
}

function onPreviewKey(e) {
  if (e.key === 'Escape' && !document.querySelector('.wz-modal, .wz-menu')) closePreviewView();
}
