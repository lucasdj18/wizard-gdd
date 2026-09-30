/* ============================================================
   media.js — mídia do documento (imagens, vídeos e áudios)

   · No arquivo: o JSON guarda só o caminho relativo (./fotoDeGatinho.png);
     a mídia fica na PASTA DO PROJETO, ao lado do JSON.
   · No navegador: cópia no OPFS (sistema de arquivos privado do site),
     em media/<id do documento>/<nome>, e pedido para não ser apagada
     (navigator.storage.persist).
   · Sem a mídia no navegador e sem acesso à pasta → aviso
     "não encontrada — dê acesso à pasta do projeto".
   ============================================================ */

const MEDIA_RULES = {
  image: {
    max: 20 * 1024 * 1024,
    mime: /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif)$/,
    ext:  /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i,
  },
  video: {
    max: 200 * 1024 * 1024,
    mime: /^video\/(mp4|webm|ogg|quicktime|x-m4v)$/,
    ext:  /\.(mp4|webm|ogv|mov|m4v)$/i,
  },
  audio: {   // 14a
    max: 50 * 1024 * 1024,
    mime: /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|mp4|x-m4a|aac|webm|flac)$/,
    ext:  /\.(mp3|wav|ogg|oga|m4a|aac|weba|flac)$/i,
  },
};

const MEDIA_TYPES = () => Object.keys(MEDIA_RULES);   // tipos de item que são mídia

// Pelo tipo MIME primeiro (um .ogg de áudio não vira vídeo); sem MIME, pela extensão
function mediaKindOf(file) {
  const rules = Object.entries(MEDIA_RULES);
  return rules.find(([, r]) => r.mime.test(file.type))?.[0]
    ?? rules.find(([, r]) => r.ext.test(file.name))?.[0]
    ?? null;
}

// Imagens da galeria (14b): a primeira é o próprio item (src); as outras ficam em `more`
const gallerySize = node => node.type === 'image' && node.gallery ? node.gallery.rows * node.gallery.cols : 1;

const mediaName = src => String(src || '').replace(/^\.\//, '');

const Media = {
  _urls: new Map(),        // "docId/nome" → object URL
  epoch: 0,                // muda quando as mídias precisam ser lidas de novo (a tela é redesenhada inteira)

  // Esquece os endereços das mídias (ex.: pasta nova): a próxima leitura busca de novo
  forget() { this._urls.clear(); this.epoch++; },

  async _dir(docId, create = true) {
    const root = await navigator.storage.getDirectory();
    const media = await root.getDirectoryHandle('media', { create });
    return media.getDirectoryHandle(docId, { create });
  },

  // Nomes de mídia usados pelo documento
  usedNames(rec) {
    const names = new Set();
    walkNodes(rec.blocks, n => {
      if (!MEDIA_TYPES().includes(n.type)) return;
      if (n.src) names.add(mediaName(n.src));
      (n.more || []).forEach(m => m?.src && names.add(mediaName(m.src)));   // galeria
    });
    return names;
  },
  hasMedia(rec) { return this.usedNames(rec).size > 0; },

  // foto.png → foto-2.png → foto-3.png… (sem repetir nome no documento nem no OPFS)
  async uniqueName(rec, wanted) {
    const clean = wanted.replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '') || 'arquivo';
    const dot = clean.lastIndexOf('.');
    const base = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
    const used = this.usedNames(rec);
    const dir = await this._dir(rec.id);
    const exists = async name => { try { await dir.getFileHandle(name); return true; } catch { return false; } };
    let name = clean, n = 2;
    while (used.has(name) || await exists(name)) name = `${base}-${n++}${ext}`;
    return name;
  },

  // Valida e guarda o arquivo no navegador; devolve { src, width, height }
  async add(rec, file, kind) {
    const rule = MEDIA_RULES[kind];
    if (!rule || mediaKindOf(file) !== kind) throw new Error(t(`media.badType.${kind}`));
    if (file.size > rule.max) throw new Error(t('media.tooBig', { max: Math.round(rule.max / 1024 / 1024) }));
    keepStorage();

    let name;
    try {
      name = await this.uniqueName(rec, file.name);
      const fh = await (await this._dir(rec.id)).getFileHandle(name, { create: true });
      await writeFile(fh, file);
    } catch (err) {
      // Aberto direto do disco (file://): o navegador não deixa guardar arquivos do site (B3)
      if (err?.name === 'SecurityError') throw new Error(t('media.noOpfs'));
      throw err;
    }
    const dims = await mediaDimensions(file, kind);
    return { src: `./${name}`, ...dims };
  },

  // Arquivo da mídia: primeiro o navegador (OPFS), depois a pasta do projeto (e guarda uma cópia no OPFS)
  async file(rec, src) {
    const name = mediaName(src);
    if (!name) return null;
    try { return await (await (await this._dir(rec.id)).getFileHandle(name)).getFile(); } catch { /* não está no navegador */ }
    if (!rec.dirHandle) return null;
    let file;
    try {
      if ((await rec.dirHandle.queryPermission({ mode: 'read' })) !== 'granted') return null;
      file = await (await rec.dirHandle.getFileHandle(name)).getFile();
    } catch (err) {
      console.warn(`Wizard: "${name}" não foi lido da pasta do projeto`, err);
      return null;
    }
    // A cópia no navegador é só um atalho para a próxima vez: se falhar, a mídia continua vindo da pasta
    try { await writeFile(await (await this._dir(rec.id)).getFileHandle(name, { create: true }), file); }
    catch (err) { console.warn(`Wizard: a cópia de "${name}" no navegador falhou`, err); }
    return file;
  },

  async url(rec, src) {
    const key = `${rec.id}/${mediaName(src)}`;
    if (this._urls.has(key)) return this._urls.get(key);
    const file = await this.file(rec, src);
    if (!file) return null;
    const url = URL.createObjectURL(file);
    this._urls.set(key, url);
    return url;
  },

  // A pasta existe mas a permissão foi esquecida (navegador fechado): pede de novo, num clique
  async unlockFolder(rec) {
    if (!rec.dirHandle) return false;
    return (await rec.dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
  },

  // Documento aberto como arquivo avulso: o navegador só deu acesso ao JSON, não às mídias ao lado.
  // O usuário escolhe a pasta do projeto (o seletor já abre na pasta do JSON); ela precisa ter as mídias.
  // Precisa ser chamado num clique. Devolve { found, total }.
  // Só leitura (basta para mostrar as mídias; o Salvar pede a edição quando precisar). Se o usuário escolher uma
  // pasta acima (ex.: a do projeto inteiro), usa a pasta onde o JSON está dentro dela.
  async chooseFolder(rec) {
    const picked = await window.showDirectoryPicker({ mode: 'read', id: 'wizard-project', ...(rec.fileHandle ? { startIn: rec.fileHandle } : {}) });
    let dir = picked;
    const path = rec.fileHandle ? await picked.resolve(rec.fileHandle).catch(() => null) : null;
    if (path?.length > 1) for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    const names = [...this.usedNames(rec)];
    let found = 0;
    for (const name of names) { try { await dir.getFileHandle(name); found++; } catch { /* não está nesta pasta */ } }
    if (names.length && !found) throw new Error(t('media.folderWrong'));
    rec.dirHandle = dir;
    this.forget();
    await Docs._commit('local');   // a pasta fica guardada com o documento
    return { found, total: names.length };
  },

  // Quantas mídias do documento o navegador não consegue ler agora (nem cópia, nem pasta liberada)
  async missing(rec) {
    let n = 0;
    for (const name of this.usedNames(rec)) if (!(await this.file(rec, `./${name}`))) n++;
    return n;
  },

  // Ao salvar: copia para a pasta do projeto as mídias que ainda não estão lá
  async exportTo(rec, dir) {
    for (const name of this.usedNames(rec)) {
      let there = false;
      try { await dir.getFileHandle(name); there = true; } catch { /* não existe na pasta */ }
      if (there) continue;
      const file = await this.file(rec, `./${name}`);
      if (file) await writeFile(await dir.getFileHandle(name, { create: true }), file);
    }
  },
};

// Largura e altura naturais (para o layout, a paginação e o DOCX não dependerem do carregamento)
async function mediaDimensions(file, kind) {
  try {
    if (kind === 'image') {
      const bmp = await createImageBitmap(file);
      const dims = { width: bmp.width, height: bmp.height };
      bmp.close?.();
      return dims;
    }
    if (kind === 'video') return await videoMetadata(file);
    if (kind === 'audio') return await audioMetadata(file);
  } catch { /* SVG e formatos sem decodificação: sem medidas */ }
  return {};
}

// Largura, altura e duração de um vídeo (lendo só os metadados)
function videoMetadata(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = dims => { URL.revokeObjectURL(url); resolve(dims); };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => done({ width: v.videoWidth || undefined, height: v.videoHeight || undefined, duration: Math.round(v.duration || 0) || undefined });
    v.onerror = () => done({});
    setTimeout(() => done({}), 5000);
    v.src = url;
  });
}

// Duração de um áudio (só os metadados)
function audioMetadata(file) {
  return new Promise(resolve => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const done = info => { URL.revokeObjectURL(url); resolve(info); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done({ duration: Math.round(a.duration || 0) || undefined });
    a.onerror = () => done({});
    setTimeout(() => done({}), 5000);
    a.src = url;
  });
}

// Seletor de arquivo simples (funciona também sem File System Access API)
function pickMediaFile(kind) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${kind}/*`;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}
