'use strict';

// Testes da ponte EMQX (sem dependências: só node:assert).
// Uso: npm test
const assert = require('node:assert/strict');
const { montarPayload, parseMapa, normalizarDispositivo, resolverDispositivo } = require('../src/emqx-bridge');

let ok = 0;
function teste(nome, fn) {
  fn();
  ok++;
  console.log('ok -', nome);
}

teste('exemplo da placa', () => {
  assert.equal(
    montarPayload({ codigo: 'CD-JE9410', descricao: 'MOLA PRATO', localizacao: '01 04 H 03', status: 'BAIXO' }),
    'CD-JE9410|MOLA PRATO|01 04 H 03|BAIXO'
  );
});

teste('remove acentos', () => {
  assert.equal(
    montarPayload({ codigo: 'X1', descricao: 'Pião Ação Çedilha', localizacao: 'Corredor Á', status: 'baixo' }),
    'X1|Piao Acao Cedilha|Corredor A|BAIXO'
  );
});

teste('troca | e quebras de linha por espaço e colapsa espaços', () => {
  assert.equal(
    montarPayload({ codigo: ' A|B ', descricao: 'linha1\nlinha2\r\nlinha3', localizacao: 'x   y\t z', status: 'ok' }),
    'A B|linha1 linha2 linha3|x y z|OK'
  );
});

teste('null/undefined viram vazio', () => {
  assert.equal(montarPayload({ codigo: null, descricao: undefined, localizacao: 'L1', status: null }), '||L1|');
  assert.equal(montarPayload({}), '|||');
  assert.equal(montarPayload(), '|||');
});

teste('status minúsculo vira maiúsculo', () => {
  assert.equal(montarPayload({ codigo: 'C', descricao: 'D', localizacao: 'L', status: 'falta' }), 'C|D|L|FALTA');
});

teste('números são convertidos para texto', () => {
  assert.equal(montarPayload({ codigo: 123, descricao: 'D', localizacao: 0, status: 'ok' }), '123|D|0|OK');
});

teste('parseMapa básico', () => {
  const m = parseMapa('ALC-000001=etiqueta01,ALC-000002=etiqueta02');
  assert.equal(m.size, 2);
  assert.equal(m.get('ALC-000001'), 'etiqueta01');
  assert.equal(m.get('ALC-000002'), 'etiqueta02');
});

teste('parseMapa tolera espaços, vazios e entradas inválidas', () => {
  const m = parseMapa(' ALC-000001 = etiqueta01 , , lixo, =x, y= ,ALC-000003=etiqueta03 ');
  assert.deepEqual([...m.entries()], [['ALC-000001', 'etiqueta01'], ['ALC-000003', 'etiqueta03']]);
});

teste('parseMapa vazio/undefined', () => {
  assert.equal(parseMapa(undefined).size, 0);
  assert.equal(parseMapa('').size, 0);
});

teste('normalizarDispositivo: trim + minúsculas', () => {
  assert.deepEqual(normalizarDispositivo('  Etiqueta01 '), { ok: true, valor: 'etiqueta01' });
  assert.deepEqual(normalizarDispositivo('placa_2-b'), { ok: true, valor: 'placa_2-b' });
  assert.deepEqual(normalizarDispositivo('0'), { ok: true, valor: '0' });
});

teste('normalizarDispositivo: vazio/null = desvincular', () => {
  assert.deepEqual(normalizarDispositivo(''), { ok: true, valor: '' });
  assert.deepEqual(normalizarDispositivo('   '), { ok: true, valor: '' });
  assert.deepEqual(normalizarDispositivo(null), { ok: true, valor: '' });
});

teste('normalizarDispositivo: inválidos', () => {
  for (const v of ['-abc', '_abc', 'a b', 'placa/1', 'a+b', 'etiquéta', 'a#', 'x'.repeat(33), {}, ['a'], true]) {
    assert.equal(normalizarDispositivo(v).ok, false, `deveria rejeitar ${JSON.stringify(v)}`);
  }
  assert.equal(normalizarDispositivo('x'.repeat(32)).ok, true);
});

teste('resolverDispositivo: coluna > mapa > nenhum', () => {
  const m = parseMapa('ALC-000001=etiqueta01,ALC-000002=etiqueta02');
  assert.deepEqual(resolverDispositivo('ALC-000001', 'placa9', m), { dispositivo: 'placa9', origem: 'coluna' });
  assert.deepEqual(resolverDispositivo('ALC-000001', null, m), { dispositivo: 'etiqueta01', origem: 'mapa' });
  assert.deepEqual(resolverDispositivo('ALC-000001', undefined, m), { dispositivo: 'etiqueta01', origem: 'mapa' });
  assert.deepEqual(resolverDispositivo('ALC-000009', null, m), { dispositivo: null, origem: null });
  assert.deepEqual(resolverDispositivo('ALC-000009', null), { dispositivo: null, origem: null });
});

teste('resolverDispositivo: coluna vazia (desvinculada) não cai no mapa', () => {
  const m = parseMapa('ALC-000001=etiqueta01');
  assert.deepEqual(resolverDispositivo('ALC-000001', '', m), { dispositivo: null, origem: null });
  assert.deepEqual(resolverDispositivo('ALC-000001', '  ', m), { dispositivo: null, origem: null });
});

console.log(`\n${ok} teste(s) passaram.`);

// Testes da lógica pura de sessão (renovação deslizante), sem banco.
require('./test-sessao');
