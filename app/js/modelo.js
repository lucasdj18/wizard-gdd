/* ============================================================
   modelo.js — modelo de GDD para "Novo a partir de modelo" (18b)
   A estrutura típica de um documento de game design, com textos-guia curtos
   (no idioma atual) para a pessoa substituir pelo conteúdo do jogo dela.
   ============================================================ */

function buildGddTemplate() {
  const block = (title, content) => ({ ...newNode('block'), title, content });
  const topic = (title, content) => ({ ...newNode('topic'), title, content });
  const desc = content => ({ ...newNode('description'), content });
  const item = text => ({ ...newNode('item'), text });
  const kv = (title, keys) => ({ ...newNode('keyvalue'), title, data: Object.fromEntries(keys.map(k => [k, ''])) });
  const table = (title, cols, rows = 2) => {
    const n = newNode('table');
    n.title = title;
    n.header[0].data = cols;
    n.rows = Array.from({ length: rows }, () => ({ id: uuid(), data: cols.map(() => '') }));
    return n;
  };
  const checklist = (title, tasks) => ({ ...newNode('checklist'), title, items: tasks.map(text => ({ id: uuid(), text, done: false })) });
  const T = k => t(`tpl.${k}`);

  return [
    block(T('overview'), [
      desc(T('overviewGuide')),
      kv(T('sheet'), [T('genre'), T('platforms'), T('audience'), T('session')]),
    ]),
    block(T('pillars'), [
      desc(T('pillarsGuide')),
      item(t('tpl.pillar', { n: 1 })), item(t('tpl.pillar', { n: 2 })), item(t('tpl.pillar', { n: 3 })),
    ]),
    block(T('mechanics'), [
      topic(T('loop'), [desc(T('loopGuide'))]),
      topic(T('controls'), [table(T('controls'), [T('action'), T('keyboard'), T('gamepad')], 3)]),
      topic(T('progression'), [desc(T('progressionGuide'))]),
    ]),
    block(T('characters'), [
      desc(T('charactersGuide')),
      table(T('characters'), [T('colName'), T('role'), T('description')]),
    ]),
    block(T('world'), [
      desc(T('worldGuide')),
      table(T('levels'), [T('level'), T('goal'), T('novelty')], 3),
    ]),
    block(T('art'), [
      desc(T('artGuide')),
      newNode('image'),
      desc(T('soundGuide')),
    ]),
    block(T('schedule'), [
      checklist(T('milestones'), [T('m1'), T('m2'), T('m3'), T('m4'), T('m5')]),
    ]),
  ];
}
