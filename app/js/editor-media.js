/* ============================================================
   editor-media.js — mídia no editor: imagem e galeria, vídeo e áudio (players próprios),
   pasta do projeto e soltar arquivos no documento.
   Parte do editor (editor.js); carregado antes dele. Arquivos e cópias: media.js.
   ============================================================ */

/* ── Mídia (imagem, vídeo e áudio) ───────────────────────── */
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

function buildMedia(node) {
  const kind  = node.type;
  const fig   = document.createElement('figure');
  const cap   = document.createElement('figcaption');
  fig.className   = `v-media v-${kind}`;
  if (node.fit)   fig.dataset.fit   = node.fit;     // ajustar (padrão) · preencher · esticar · original
  if (node.align) fig.dataset.align = node.align;   // centro (padrão) · esquerda · direita
  cap.className   = 'v-media-caption primary-field';
  editable(cap, node, 'caption', { placeholder: t('ph.caption') });

  // Galeria (14b): linhas × colunas de quadros; o primeiro é a própria imagem do item
  const size = gallerySize(node);
  if (size > 1) {
    const grid = document.createElement('div');
    grid.className = 'v-gallery';
    grid.style.setProperty('--cols', node.gallery.cols);
    for (let slot = 0; slot < size; slot++) grid.appendChild(mediaFrame(node, slot));
    fig.append(grid, cap);
  } else {
    fig.append(mediaFrame(node, 0), cap);
  }
  return fig;
}

// A mídia de um quadro: o próprio item (slot 0) ou uma imagem extra da galeria
const slotMedia = (node, slot) => slot ? (node.more?.[slot - 1] ?? {}) : node;

// Quadro da mídia; arrastar um arquivo para cima dele troca a mídia daquele quadro
function mediaFrame(node, slot) {
  const kind  = node.type;
  const frame = document.createElement('div');
  frame.className = 'v-media-frame' + (gallerySize(node) > 1 ? ' v-gallery-cell' : '');
  frame.dataset.slot = slot;
  fillMediaFrame(frame, node, slot);
  frame.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    frame.classList.add('drop-over');
  });
  frame.addEventListener('dragleave', () => frame.classList.remove('drop-over'));
  frame.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    frame.classList.remove('drop-over');
    const file = [...e.dataTransfer.files].find(f => mediaKindOf(f) === kind);
    if (file) setMediaFile(node, file, slot);
    else toast(t('media.error'), t(`media.badType.${kind}`));
  });
  return frame;
}

async function fillMediaFrame(frame, node, slot = 0) {
  const kind = node.type;
  const rec  = Docs.current;
  const media = slotMedia(node, slot);

  if (!media.src) {
    const hint = slot ? '' : `<div>${esc(t(`media.empty.${kind}`))}</div>`;   // na galeria, só o botão
    frame.innerHTML = `<div class="v-media-empty">${hint}<button class="btn-add-item" title="${esc(slot ? t('gallery.slot', { n: slot + 1 }) : '')}">${esc(t(`media.choose.${kind}`))}</button></div>`;
    frame.querySelector('button').addEventListener('click', async () => {
      const file = await pickMediaFile(kind);
      if (file) setMediaFile(node, file, slot);
    });
    return;
  }

  frame.innerHTML = `<div class="v-media-empty v-media-loading">${esc(t('media.loading'))}</div>`;
  const url = await Media.url(rec, media.src);
  if (!frame.isConnected) return;

  if (!url) {
    frame.innerHTML = `<div class="v-media-empty v-media-missing"><div>⚠ ${esc(t(`media.missing.${kind}`))}</div><code>${esc(media.src)}</code></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn-add-item';
    if (rec.dirHandle) {   // a pasta já está ligada: só falta a permissão (esquecida ao fechar o navegador)
      btn.textContent = t('media.unlock');
      btn.addEventListener('click', async () => { if (await Media.unlockFolder(rec)) renderEditor({ full: true }); });   // mídias liberadas: todas de novo
    } else if ('showDirectoryPicker' in window) {   // aberto como arquivo avulso: pede a pasta do projeto
      btn.textContent = t('media.chooseFolder');
      btn.addEventListener('click', () => pickProjectFolder(rec));
    } else return;
    frame.firstChild.appendChild(btn);
    return;
  }

  const el = createMediaElement(node, url, media);
  frame.innerHTML = '';
  frame.appendChild(el);
  schedulePagination();
}

// media: o que está no quadro (o item ou uma imagem da galeria), com as medidas naturais
function createMediaElement(node, url, media = node) {
  if (node.type === 'video') return createVideoPlayer(node, url);
  if (node.type === 'audio') return createAudioPlayer(node, url);
  const img = document.createElement('img');
  img.src = url;
  img.alt = node.caption || '';
  img.draggable = false;
  if (media.width && media.height) { img.width = media.width; img.height = media.height; }
  return img;
}

// Player de áudio (14a): uma faixa da altura de um item — Play à esquerda, minutagem à direita e, entre
// eles, a onda (estilo Deezer) ou uma linha (estilo Spotify). Visual e velocidade ficam no menu do item.
const WAVE_BARS = 72;
const wavePeaks = new Map();   // url → alturas (0..1), calculadas uma vez
async function audioPeaks(url) {
  if (wavePeaks.has(url)) return wavePeaks.get(url);
  const job = (async () => {
    const data = await (await fetch(url)).arrayBuffer();
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    const buf = await ctx.decodeAudioData(data);
    const ch = buf.getChannelData(0), step = Math.max(1, Math.floor(ch.length / WAVE_BARS));
    const peaks = Array.from({ length: WAVE_BARS }, (_, i) => {
      let sum = 0;
      for (let j = i * step, end = Math.min(ch.length, j + step); j < end; j += 16) sum += ch[j] * ch[j];
      return Math.sqrt(sum / (step / 16));
    });
    const max = Math.max(...peaks) || 1;
    return peaks.map(p => Math.max(0.08, p / max));
  })();
  wavePeaks.set(url, job);
  return job.catch(() => { wavePeaks.delete(url); return null; });
}

const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function createAudioPlayer(node, url) {
  const look = node.look || AUDIO_LOOKS[0];
  const box = document.createElement('div');
  box.className = `wz-audio paused look-${look}`;
  box.tabIndex = 0;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', node.caption || mediaName(node.src));
  box.innerHTML = `
    <audio preload="metadata"></audio>
    <button class="wz-audio-play" aria-label="${esc(t('player.play'))}"><span class="wz-play-icon"></span></button>
    <div class="wz-audio-track" role="slider" aria-label="${esc(t('player.progressAudio'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="wz-audio-line"><div class="wz-audio-fill"></div></div>
      <div class="wz-audio-wave"></div>
    </div>
    <div class="wz-audio-time">0:00 / ${fmtTime(node.duration)}</div>
    <div class="wz-print-label">♪ ${esc(mediaName(node.src))}${node.duration ? ` · ${fmtTime(node.duration)}` : ''}</div>`;
  const audio = box.querySelector('audio');
  const play  = box.querySelector('.wz-audio-play');
  const track = box.querySelector('.wz-audio-track');
  const fill  = box.querySelector('.wz-audio-fill');
  const wave  = box.querySelector('.wz-audio-wave');
  const time  = box.querySelector('.wz-audio-time');
  audio.src = url;
  audio.playbackRate = node.speed || 1;
  audio.defaultPlaybackRate = node.speed || 1;

  // Onda: barras com a altura do volume; sem decodificar (formato raro), vira linha
  if (look === 'wave') {
    wave.innerHTML = Array.from({ length: WAVE_BARS }, () => '<span></span>').join('');
    audioPeaks(url).then(peaks => {
      if (!peaks) return box.classList.replace('look-wave', 'look-line');
      [...wave.children].forEach((b, i) => { b.style.height = `${Math.round(peaks[i] * 100)}%`; });
    });
  }

  const toggle = () => { audio.paused ? audio.play().catch(() => {}) : audio.pause(); };
  const sync = () => {
    box.classList.toggle('paused', audio.paused);
    play.setAttribute('aria-label', t(audio.paused ? 'player.play' : 'player.pause'));
  };
  const progress = () => {
    const dur = audio.duration || node.duration || 0;
    const pct = dur ? (audio.currentTime / dur) * 100 : 0;
    fill.style.width = pct + '%';
    box.style.setProperty('--played', pct + '%');
    [...wave.children].forEach((b, i) => b.classList.toggle('played', (i + 0.5) / WAVE_BARS * 100 <= pct));
    track.setAttribute('aria-valuenow', String(Math.round(pct)));
    time.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(dur)}`;
  };
  const seekTo = clientX => {
    const r = track.getBoundingClientRect();
    const dur = audio.duration || node.duration;
    if (dur) { audio.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * dur; progress(); }
  };

  audio.addEventListener('play', sync);
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', sync);
  audio.addEventListener('timeupdate', progress);
  audio.addEventListener('loadedmetadata', progress);
  play.addEventListener('click', e => { e.stopPropagation(); toggle(); });
  track.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    try { track.setPointerCapture(e.pointerId); } catch { /* sem captura, o clique ainda posiciona */ }
    seekTo(e.clientX);
    const move = ev => seekTo(ev.clientX);
    const up = () => track.removeEventListener('pointermove', move);
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up, { once: true });
    track.addEventListener('pointercancel', up, { once: true });
  });
  box.addEventListener('keydown', e => {
    if (e.target !== box) return;
    if (e.key === ' ' || e.key.toLowerCase() === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 5); }
  });
  return box;
}

// Player discreto (9b): barra de progresso colada na borda de baixo e Play/Pause no centro.
// Clique no vídeo ou Espaço/K alterna; ← → pulam 5 s. Sem os controles padrão do navegador.
function createVideoPlayer(node, url) {
  const box = document.createElement('div');
  box.className = 'wz-player paused';
  box.tabIndex = 0;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', node.caption || mediaName(node.src));
  box.innerHTML = `
    <video preload="metadata" playsinline></video>
    <button class="wz-play" aria-label="${esc(t('player.play'))}"><span class="wz-play-icon"></span></button>
    <div class="wz-progress" role="slider" aria-label="${esc(t('player.progress'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1"><div class="wz-progress-fill"></div></div>
    <div class="wz-print-label">▶ ${esc(mediaName(node.src))}</div>`;
  const video = box.querySelector('video');
  const play  = box.querySelector('.wz-play');
  const bar   = box.querySelector('.wz-progress');
  const fill  = box.querySelector('.wz-progress-fill');
  video.src = url;
  if (node.width && node.height) { video.width = node.width; video.height = node.height; }

  const toggle = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };
  const sync = () => {
    box.classList.toggle('paused', video.paused);
    play.setAttribute('aria-label', t(video.paused ? 'player.play' : 'player.pause'));
  };
  const progress = () => {
    const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    fill.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  };
  const seekTo = clientX => {
    const r = bar.getBoundingClientRect();
    if (video.duration) video.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * video.duration;
  };

  video.addEventListener('play', sync);
  video.addEventListener('pause', sync);
  video.addEventListener('ended', sync);
  video.addEventListener('timeupdate', progress);
  video.addEventListener('loadedmetadata', progress);
  video.addEventListener('click', toggle);
  play.addEventListener('click', e => { e.stopPropagation(); toggle(); });

  // Arrastar na barra de progresso (mouse e toque)
  bar.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    try { bar.setPointerCapture(e.pointerId); } catch { /* sem captura, o clique ainda posiciona */ }
    box.classList.add('seeking');
    seekTo(e.clientX);
    const move = ev => seekTo(ev.clientX);
    const up = () => { box.classList.remove('seeking'); bar.removeEventListener('pointermove', move); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up, { once: true });
    bar.addEventListener('pointercancel', up, { once: true });
  });

  box.addEventListener('keydown', e => {
    if (e.target !== box) return;
    if (e.key === ' ' || e.key.toLowerCase() === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); }
  });
  return box;
}

// Pasta do projeto para um documento aberto como arquivo avulso (as mídias ficam ao lado do JSON)
async function pickProjectFolder(rec) {
  try {
    const { found, total } = await Media.chooseFolder(rec);
    toast(t('media.folderOk'), t('media.folderOkMsg', { found, total }));
    renderEditor({ full: true });   // mídias da pasta: todas de novo
  } catch (err) {
    if (!isAbort(err)) toast(t('media.error'), err.message);
  }
}

// Ao abrir um documento com mídias que o navegador não consegue ler: pergunta uma vez se quer dar acesso à pasta
const askedFolder = new Set();
async function checkMediaAccess() {
  const rec = Docs.current;
  if (!rec || rec.dirHandle || rec.example || askedFolder.has(rec.id) || !('showDirectoryPicker' in window) || !Media.hasMedia(rec)) return;
  const missing = await Media.missing(rec);
  if (!missing || Docs.current !== rec || document.querySelector('.wz-modal')) return;
  askedFolder.add(rec.id);
  const choice = await askChoice({
    title: t('media.askFolderTitle'),
    message: t('media.askFolderMsg', { n: missing, file: rec.fileName || rec.name }),
    options: [
      { value: 'yes', label: t('media.askFolderYes'), primary: true },
      { value: 'no', label: t('media.askFolderNo') },
    ],
  });
  if (choice === 'yes') await pickProjectFolder(rec);   // o clique no botão libera o seletor de pasta
}

// Operação no histórico: INSERIR_IMAGEM, REMOVER_VIDEO, INSERIR_AUDIO…
const mediaOp = (kind, verb) => `${verb}_${{ image: 'IMAGEM', video: 'VIDEO', audio: 'AUDIO' }[kind]}`;

// slot > 0: uma imagem da galeria (14b), guardada em node.more[slot - 1]
async function setMediaFile(node, file, slot = 0) {
  const kind = node.type;
  try {
    const info = await Media.add(Docs.current, file, kind);
    await structural(() => {
      if (!slot) return Object.assign(node, info);
      node.more ??= [];
      node.more[slot - 1] = info;
    }, { op: mediaOp(kind, 'INSERIR') });
  } catch (err) {
    toast(t('media.error'), err.message);
  }
}

// Soltar arquivos no documento: mídia vira item novo no contêiner/tópico; JSON do Wizard é importado
async function handleFileDrop(e) {
  const target = e.target instanceof Element ? e.target : null;
  const files = [...e.dataTransfer.files];
  const handles = await Promise.all([...e.dataTransfer.items].map(it => it.getAsFileSystemHandle?.().catch(() => null) ?? null));
  clearDropMarks();

  // JSON: entra na lista de documentos (com NEW), sem trocar o aberto
  const jsonIdx = files.map((f, i) => /\.json$/i.test(f.name) ? i : -1).filter(i => i >= 0);
  if (jsonIdx.length) {
    const ids = [];
    for (const i of jsonIdx) {
      try {
        const fh = handles[i]?.kind === 'file' ? handles[i] : null;
        const perm = fh ? ((await fh.requestPermission({ mode: 'readwrite' })) === 'granted' ? 'readwrite' : 'read') : 'none';
        ids.push((await Docs.importQuiet(await files[i].text(), fh, perm)).id);
      } catch (err) { toast(t('open.invalid'), err.message); }
    }
    if (ids.length) openDocManager({ newIds: ids });
  }

  // Mídia: no tópico ou contêiner onde foi solta (ou no último contêiner)
  const media = files.filter(f => mediaKindOf(f));
  const rejected = files.filter(f => !mediaKindOf(f) && !/\.json$/i.test(f.name));
  rejected.forEach(f => toast(t('media.error'), `${f.name}: ${t('media.unsupported')}`));
  if (!media.length) return;

  const parentId = target?.closest('.v-topic-body, .v-grid-col')?.dataset.parentId
    || target?.closest('.entry:not(.entry-grid)')?.dataset.nodeId
    || blocks().flatMap(b => b.type === 'chapter' ? b.content || [] : b.type === 'block' ? [b] : []).at(-1)?.id
    || null;

  const added = [];
  for (const file of media) {
    try { added.push({ kind: mediaKindOf(file), info: await Media.add(Docs.current, file, mediaKindOf(file)) }); }
    catch (err) { toast(t('media.error'), `${file.name}: ${err.message}`); }
  }
  if (!added.length) return;
  await structural(() => {
    const parent = parentId || Model.addContainer().id;
    added.forEach(({ kind, info }) => Object.assign(Model.addItem(kind, { parentId: parent }), info));
  }, { op: mediaOp(added[0].kind, 'INSERIR') });
}

function clearDropMarks() {
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
}

function initFileDrop() {
  const main = mainEl();
  let leaveTimer = null;
  // Evita que o navegador abra o arquivo solto fora do editor
  document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', e => { if (hasFiles(e) && !main.contains(e.target)) e.preventDefault(); });
  main.addEventListener('dragover', e => {
    if (!hasFiles(e) || !Docs.current) return;
    e.preventDefault();
    clearTimeout(leaveTimer);
    const zone = e.target.closest?.('.v-topic-body, .v-grid-col, .entry:not(.entry-grid)');
    if (!zone?.classList.contains('drop-target')) { clearDropMarks(); zone?.classList.add('drop-target'); }
  });
  main.addEventListener('dragleave', () => { leaveTimer = setTimeout(clearDropMarks, 80); });
  main.addEventListener('drop', e => {
    if (!hasFiles(e) || !Docs.current) return;
    e.preventDefault();
    handleFileDrop(e);
  });
}
