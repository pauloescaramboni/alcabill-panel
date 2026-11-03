'use strict';

// Hash de senha com scrypt (módulo nativo node:crypto — sem bcrypt/bcryptjs,
// que exigiriam npm install indisponível neste sandbox). scrypt é uma escolha
// de hashing de senha reconhecida (RFC 7914), não uma solução improvisada.

const crypto = require('node:crypto');

function hashPassword(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(senha, hash, salt) {
  const tentativa = crypto.scryptSync(senha, salt, 64).toString('hex');
  const a = Buffer.from(tentativa, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Sessões no Postgres (tabela `sessoes`).
//
// Antes ficavam num Map em memória — e o Render free dorme/reinicia o
// processo, o que deslogava todo mundo. Agora o token opaco (sid) aponta para
// uma linha no banco, com validade de 30 dias e renovação deslizante: quando
// faltam menos de 15 dias, a validade volta para +30 dias (no máximo um
// UPDATE por requisição, e só nessas requisições).
//
// O `require('./db')` é preguiçoso de propósito: assim as funções puras
// (precisaRenovar/novaExpiracao) podem ser testadas sem o driver `pg` nem
// banco nenhum (ver scripts/test-sessao.js).
// ---------------------------------------------------------------------------

const DIA_MS = 24 * 60 * 60 * 1000;
const DURACAO_SESSAO_MS = 30 * DIA_MS;
const LIMIAR_RENOVACAO_MS = 15 * DIA_MS;
const DURACAO_SESSAO_S = DURACAO_SESSAO_MS / 1000; // 2592000 — Max-Age do cookie
const RE_SID = /^[0-9a-f]{64}$/;

function banco() {
  return require('./db');
}

// Função pura: a sessão deve ser renovada se faltar menos de 15 dias.
function precisaRenovar(expiraEm, agora = Date.now()) {
  const exp = expiraEm instanceof Date ? expiraEm.getTime() : new Date(expiraEm).getTime();
  const now = agora instanceof Date ? agora.getTime() : agora;
  if (!Number.isFinite(exp)) return true;
  return exp - now < LIMIAR_RENOVACAO_MS;
}

// Função pura: nova data de expiração a partir de "agora".
function novaExpiracao(agora = Date.now()) {
  const now = agora instanceof Date ? agora.getTime() : agora;
  return new Date(now + DURACAO_SESSAO_MS);
}

async function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  await banco().pool.query(
    'INSERT INTO sessoes (sid, usuario_id, expira_em) VALUES ($1, $2, $3)',
    [sid, userId, novaExpiracao()]
  );
  return sid;
}

// Devolve { sid, userId, usuario: {id, nome, email, papel}, expiraEm, renovada }
// ou null se a sessão não existe/expirou. Uma query só (sessão + usuário).
async function getSession(sid) {
  if (typeof sid !== 'string' || !RE_SID.test(sid)) return null;
  const { pool } = banco();
  const r = await pool.query(
    `SELECT s.sid, s.expira_em, u.id, u.nome, u.email, u.papel
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.sid = $1 AND s.expira_em > now()`,
    [sid]
  );
  const row = r.rows[0];
  if (!row) return null;

  let expiraEm = row.expira_em;
  let renovada = false;
  if (precisaRenovar(expiraEm)) {
    expiraEm = novaExpiracao();
    await pool.query('UPDATE sessoes SET expira_em = $1 WHERE sid = $2', [expiraEm, sid]);
    renovada = true;
  }
  return {
    sid: row.sid,
    userId: row.id,
    usuario: { id: row.id, nome: row.nome, email: row.email, papel: row.papel },
    expiraEm,
    renovada,
  };
}

async function destroySession(sid) {
  if (typeof sid !== 'string' || !RE_SID.test(sid)) return;
  await banco().pool.query('DELETE FROM sessoes WHERE sid = $1', [sid]);
}

// Apaga todas as sessões do usuário, menos a atual (usado na troca de senha).
async function destroyOtherSessions(userId, sidAtual) {
  const r = await banco().pool.query(
    'DELETE FROM sessoes WHERE usuario_id = $1 AND sid <> $2',
    [userId, sidAtual || '']
  );
  return r.rowCount;
}

async function limparSessoesExpiradas() {
  const r = await banco().pool.query('DELETE FROM sessoes WHERE expira_em < now()');
  return r.rowCount;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  destroyOtherSessions,
  limparSessoesExpiradas,
  precisaRenovar,
  novaExpiracao,
  DURACAO_SESSAO_MS,
  LIMIAR_RENOVACAO_MS,
  DURACAO_SESSAO_S,
};
