/* ============================================================
   format.js — formato nativo do Wizard (JSON versionado)

   Arquivo v1:
   {
     "wizard":   { "version": "1.0" },
     "document": { "id", "name", "createdAt", "modifiedAt", "blocks": [...] }
   }
   v0 = formato antigo: um array de blocos, sem envelope.

   parseWizardText(texto, nomeDoArquivo) valida nesta ordem:
   1. JSON válido · 2. estrutura do Wizard · 3. versão · 4. compatível · 5. migrar
   ============================================================ */

const WIZARD_FORMAT = '1.0';
const FORMAT_MAJOR  = 1;

class WizardFormatError extends Error {}

// Migrações: cada uma recebe o arquivo da versão N e devolve o da N+1
const MIGRATIONS = {
  // v0 (array de blocos) → v1 (envelope + metadados). O campo "flag" (sempre false) sai.
  0: (blocks, { fileName }) => {
    const now = new Date().toISOString();
    walkNodes(blocks, n => { delete n.flag; });
    return {
      wizard: { version: '1.0' },
      document: {
        id:         uuid(),
        name:       (fileName || '').replace(/\.json$/i, '') || t('doc.defaultName'),
        createdAt:  now,
        modifiedAt: now,
        blocks,
      },
    };
  },
};

function detectVersion(data) {
  if (Array.isArray(data)) return 0;
  if (data && typeof data === 'object' && data.wizard && typeof data.wizard.version === 'string') {
    const major = parseInt(data.wizard.version, 10);
    if (Number.isFinite(major)) return major;
  }
  return null; // não é Wizard
}

function isV0Blocks(list) {
  return list.length === 0 || list.every(b => b && typeof b === 'object' && (Array.isArray(b.content) || b.type === 'block'));
}

// Devolve { doc, fromVersion, fixedIds } ou lança WizardFormatError com mensagem traduzida
function parseWizardText(raw, fileName = '') {
  const text = stripBOM(raw ?? '');
  const who  = fileName || 'JSON';

  // Arquivo vazio = documento novo e vazio
  if (!text.trim()) return { doc: MIGRATIONS[0]([], { fileName }).document, fromVersion: null, fixedIds: 0 };

  // 1. JSON válido
  let data;
  try { data = JSON.parse(text); }
  catch (err) { throw new WizardFormatError(`${who} ${t('err.notJson', { detail: err.message })}`); }

  // 2 e 3. Estrutura do Wizard e versão
  let version = detectVersion(data);
  if (version === null || (version === 0 && !isV0Blocks(data))) {
    throw new WizardFormatError(`${who} ${t('err.notWizard')}`);
  }

  // 4. Compatível
  if (version > FORMAT_MAJOR) {
    throw new WizardFormatError(`${who} ${t('err.newerVersion', { version: data.wizard.version })}`);
  }

  // 5. Migrar até a versão atual
  const fromVersion = version;
  if (version === 0) data = normalizeDoc(data);
  while (version < FORMAT_MAJOR) {
    data = MIGRATIONS[version](data, { fileName });
    version++;
  }

  const doc = data.document;
  if (!doc || !Array.isArray(doc.blocks)) throw new WizardFormatError(`${who} ${t('err.noBlocks')}`);
  doc.id         ||= uuid();
  doc.name       ||= t('doc.defaultName');
  doc.createdAt  ||= new Date().toISOString();
  doc.modifiedAt ||= doc.createdAt;
  doc.blocks = normalizeDoc(doc.blocks);

  return { doc, fromVersion: fromVersion < FORMAT_MAJOR ? fromVersion : null, fixedIds: fixDuplicateIds(doc.blocks) };
}

// IDs repetidos (arquivos antigos tinham) → novo UUID para as repetições
function fixDuplicateIds(blocks) {
  const seen = new Set();
  let fixed = 0;
  walkNodes(blocks, n => {
    if (seen.has(n.id)) { n.id = uuid(); fixed++; }
    seen.add(n.id);
  });
  return fixed;
}

// Texto do arquivo v1 a partir do registro do documento
function serializeDocument(rec) {
  return JSON.stringify({
    wizard: { version: WIZARD_FORMAT },
    document: {
      id:         rec.id,
      name:       rec.name,
      createdAt:  rec.createdAt,
      modifiedAt: rec.modifiedAt,
      blocks:     rec.blocks,
    },
  }, null, 2);
}
