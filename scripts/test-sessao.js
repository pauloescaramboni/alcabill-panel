'use strict';

// Testes da lógica pura de sessão (renovação deslizante) — sem banco.
// Roda junto com `npm test` (chamado ao fim de scripts/test-bridge.js).
const assert = require('node:assert/strict');
const auth = require('../src/auth');

const DIA = 24 * 60 * 60 * 1000;
const agora = Date.UTC(2026, 10, 3, 12, 0, 0);
let ok = 0;
function teste(nome, fn) { fn(); ok++; console.log('ok -', nome); }

teste('constantes: 30 dias / Max-Age 2592000', () => {
  assert.equal(auth.DURACAO_SESSAO_MS, 30 * DIA);
  assert.equal(auth.DURACAO_SESSAO_S, 2592000);
});

teste('novaExpiracao = agora + 30 dias', () => {
  assert.equal(auth.novaExpiracao(agora).getTime(), agora + 30 * DIA);
  assert.equal(auth.novaExpiracao(new Date(agora)).getTime(), agora + 30 * DIA);
});

teste('não renova com 30, 20 ou exatamente 15 dias restantes', () => {
  assert.equal(auth.precisaRenovar(new Date(agora + 30 * DIA), agora), false);
  assert.equal(auth.precisaRenovar(new Date(agora + 20 * DIA), agora), false);
  assert.equal(auth.precisaRenovar(new Date(agora + 15 * DIA), agora), false);
});

teste('renova com menos de 15 dias restantes', () => {
  assert.equal(auth.precisaRenovar(new Date(agora + 15 * DIA - 1), agora), true);
  assert.equal(auth.precisaRenovar(new Date(agora + 1 * DIA), agora), true);
});

teste('aceita string ISO (como o pg pode devolver) e trata data inválida', () => {
  assert.equal(auth.precisaRenovar(new Date(agora + 29 * DIA).toISOString(), agora), false);
  assert.equal(auth.precisaRenovar('lixo', agora), true);
});

console.log(`\n${ok} teste(s) de sessão passaram.`);
