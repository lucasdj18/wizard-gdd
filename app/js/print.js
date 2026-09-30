/* ============================================================
   print.js — impressão (Ctrl+P) em A4

   · Imprime só o documento (nome + contêineres), em tema claro;
     menus, botões, sidebar e alças ficam de fora.
   · Paginação A4: uma cópia invisível do documento, na largura exata
     da página e com o estilo de impressão, é medida para calcular onde
     cada página quebra. As quebras aparecem na tela como uma linha
     cinza discreta ("Página N") e são aplicadas na impressão, para o
     papel sair igual ao que a tela mostra.
   · Regras: o que cabe fica na página; item que não pode ser dividido
     (tabela, chave-valor, checklist…) começa na página seguinte, a não ser
     que seja maior que uma página (aí se divide onde está); o título
     de um contêiner/tópico nunca fica sozinho no pé da página; contêiner
     que ficaria dividido com menos de 30% da página em cima vai inteiro
     para a página seguinte.
   · Só as quebras calculadas aqui decidem as páginas; o CSS evita cortar
     apenas as partes mínimas (linha de tabela, par, tarefa, mídia, títulos).
   ============================================================ */

const PAGE = { width: '180mm', height: '267mm' };   // A4 (210 × 297 mm) menos margens de 15 mm

let breakKeys = [];          // chaves dos elementos que começam uma página nova
let paginateTimer = null;

// Mede em px um comprimento CSS (ex.: '267mm')
function cssToPx(len) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;height:${len}`;
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}

// Unidades do fluxo, na ordem da página: nome do documento, título de contêiner, itens, título de tópico.
// `entry` = id do contêiner a que a unidade pertence.
// O grid é uma unidade só (as colunas ficam lado a lado): o que está dentro dele não entra no fluxo.
function flowUnits(root) {
  const inGrid = el => !!el.parentElement.closest('.v-grid');
  return [...root.querySelectorAll('.doc-title, .chapter-header, .entry-header, .entry-grid, .v-node:not(.v-node-topic), .v-topic-header')].filter(el => !inGrid(el)).map(el => {
    const entry = el.closest('.entry')?.dataset.nodeId ?? null;
    if (el.classList.contains('doc-title'))    return { el, kind: 'title', key: null, entry };
    // Título do capítulo: como o do tópico, vai junto com o que vem depois (não fica sozinho no pé da página)
    if (el.classList.contains('chapter-header')) return { el, kind: 'topic', key: el.closest('.chapter').dataset.nodeId, entry: null };
    if (el.classList.contains('entry-header')) return { el, kind: 'container', key: entry, entry };
    if (el.classList.contains('v-topic-header')) return { el, kind: 'topic', key: el.closest('.v-node').dataset.nodeId, entry };
    return { el, kind: 'item', key: el.dataset.nodeId, entry };
  });
}

// Contêiner dividido com menos disto da página em cima: vai inteiro para a página seguinte
const MIN_CONTAINER_TOP = 0.3;
const PARTS = [
  { item: '.v-node-table',     rows: '.gdd-table tbody tr' },
  { item: '.v-node-checklist', rows: '.v-task' },
  { item: '.v-node-keyvalue',  rows: '.v-kv-key', pair: true },
  { item: '.v-node-summary',   rows: '.v-sum-row' },
];
const PAGE_SAFETY = 0.97;

// Calcula as quebras numa cópia do documento com a largura e o estilo da impressão
function computeBreaks() {
  const main = document.getElementById('editor-main');
  if (!main || !Docs.current) return [];

  const sheet = document.createElement('div');
  sheet.className = 'pm print-measure';
  sheet.style.width = PAGE.width;
  const clone = main.cloneNode(true);
  clone.hidden = false;                 // o editor pode estar escondido pelo preview
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  clone.querySelectorAll('.page-break-line').forEach(n => n.remove());
  sheet.appendChild(clone);
  document.body.appendChild(sheet);

  // Folga de ~1 linha: a medição e a impressão real diferem alguns pixels (ex.: tabela dividida), e sem folga
  // o navegador quebra antes do calculado e a quebra forçada seguinte deixa uma página quase vazia
  const fullH = cssToPx(PAGE.height);
  const pageH = fullH * PAGE_SAFETY;
  const originY = sheet.getBoundingClientRect().top;
  const box = el => { const r = el.getBoundingClientRect(); return { top: r.top - originY, bottom: r.bottom - originY }; };
  const units = flowUnits(sheet).map(u => {
    // Tabela: as linhas contam uma a uma, porque o navegador divide a tabela entre linhas e repete o cabeçalho
    // Itens divisíveis (6d): a tabela entre linhas, o checklist entre tarefas, o chave-valor entre pares,
    // o sumário entre linhas — cada parte conta sozinha (texto longo quebra entre linhas pelo próprio navegador)
    const part = PARTS.find(p => u.el.matches(p.item));
    const rows = part ? [...u.el.querySelectorAll(part.rows)].map(el => {
      const b = box(el);
      if (part.pair) b.bottom = Math.max(b.bottom, box(el.nextElementSibling).bottom);   // par: chave + valor
      return b;
    }) : [];
    const head = u.el.querySelector('.gdd-table thead');
    return { ...u, ...box(u.el), rows, headH: head ? head.getBoundingClientRect().height : 0 };
  });
  sheet.remove();

  const containers = new Map(units.filter(u => u.kind === 'container').map(u => [u.entry, u]));
  const breaks = [];
  let pageStart = 0;
  units.forEach((u, i) => {
    if (u.bottom - pageStart <= pageH) return;             // cabe nesta página
    const prev = units[i - 1];
    const left = pageStart + pageH - u.top;                // espaço que sobra na página para este item
    // Item maior que uma página vai se dividir de qualquer jeito: só pula se sobrar menos de 30% da página
    const big = u.bottom - u.top > pageH;
    let anchor = big && left >= pageH * MIN_CONTAINER_TOP ? null : u;
    // O título do contêiner/tópico vai junto com o primeiro item (não fica sozinho no pé da página)
    if (anchor && prev && (prev.kind === 'container' || prev.kind === 'topic') && prev.top > pageStart) anchor = prev;
    // Contêiner dividido cuja parte de cima (do título até o corte) ocupa menos de 30% da página:
    // começa inteiro na página seguinte
    const cont = containers.get(u.entry);
    const cutAt = anchor ? anchor.top : pageStart + pageH;
    if (cont && cont.top > pageStart && cutAt - cont.top < pageH * MIN_CONTAINER_TOP) anchor = cont;
    if (anchor && anchor.top > pageStart && anchor.key) {
      breaks.push(anchor.key);
      pageStart = anchor.top;
    }
    // O item se divide: a página seguinte começa onde ele transborda (na tabela, na linha que não coube)
    if (u.rows.length) {
      u.rows.forEach(r => { if (r.bottom - pageStart > pageH) pageStart = r.top - u.headH; });
    } else {
      while (u.bottom - pageStart > pageH) pageStart += fullH;
    }
  });
  return [...new Set(breaks)];
}

// Elemento na tela que corresponde a uma chave de quebra (contêiner inteiro ou item)
function breakElement(key) {
  return document.querySelector(`#editor-main [data-node-id="${CSS.escape(key)}"]`);
}

// Desenha as linhas "Página N" na tela e marca os elementos que começam página na impressão
function applyBreaks(keys) {
  const main = document.getElementById('editor-main');
  if (!main) return;
  main.querySelectorAll('.page-break-line').forEach(n => n.remove());
  main.querySelectorAll('.print-break-before').forEach(n => n.classList.remove('print-break-before'));

  keys.forEach((key, i) => {
    const el = breakElement(key);
    if (!el) return;
    el.classList.add('print-break-before');
    const line = document.createElement('div');
    line.className = 'page-break-line';
    line.setAttribute('aria-hidden', 'true');
    line.innerHTML = `<span>${esc(t('print.page', { n: i + 2 }))}</span>`;
    el.before(line);
  });
}

function paginate() {
  clearTimeout(paginateTimer);
  paginateTimer = null;
  if (document.querySelector('.cell-editing')) return schedulePagination();   // não mexe no layout durante a edição
  breakKeys = computeBreaks();
  applyBreaks(breakKeys);
}

// Recalcula com um pequeno atraso (depois de renderizar ou editar)
function schedulePagination(delay = 400) {
  clearTimeout(paginateTimer);
  paginateTimer = setTimeout(paginate, delay);
}

// Ctrl+P / window.print(): quebras em dia e tema de impressão
window.addEventListener('beforeprint', () => {
  if (document.querySelector('.cell-editing')) document.activeElement?.blur();
  breakKeys = computeBreaks();
  applyBreaks(breakKeys);
  document.body.classList.add('pm');
});
window.addEventListener('afterprint', () => document.body.classList.remove('pm'));

// Fontes carregadas mudam as medidas
document.fonts?.ready.then(() => schedulePagination(0));
