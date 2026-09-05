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

// Sessões: token opaco -> { userId, criado_em }, guardado em memória.
// Suficiente para um protótipo de um único processo; numa versão comercial
// isso vira um cookie assinado ou JWT com expiração e store compartilhado
// (a auditoria já lista isso como pendência de segurança da V1 -> comercial).
const sessions = new Map();

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, criado_em: Date.now() });
  return token;
}

function getSession(token) {
  return sessions.get(token);
}

function destroySession(token) {
  sessions.delete(token);
}

module.exports = { hashPassword, verifyPassword, createSession, getSession, destroySession };
