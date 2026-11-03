'use strict';

// Testes da ponte EMQX (sem dependências: só node:assert).
// Uso: npm test
const assert = require('node:assert/strict');
const { montarPayload, parseMapa } = require('../src/emqx-bridge');

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

console.log(`\n${ok} teste(s) passaram.`);

// Testes da lógica pura de sessão (renovação deslizante), sem banco.
require('./test-sessao');
