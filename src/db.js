'use strict';

// Banco de dados: Postgres, via o driver oficial `pg`.
//
// Isto substitui o `node:sqlite` usado na primeira versão deste protótipo.
// O motivo da troca: o plano é hospedar o painel no Render, e os serviços
// web gratuitos do Render têm disco *efêmero* — um arquivo SQLite gravado
// ali seria apagado a cada novo deploy/reinício. O Postgres do Render fica
// num serviço separado, com disco persistente de verdade.
//
// Para manter o resto do código (server.js, seed.js) o mais parecido
// possível com a versão SQLite, este arquivo expõe a mesma "forma" de API
// que já era usada antes — db.prepare(sql).run/get/all(...params) — só que
// agora essas três funções são assíncronas (o driver `pg` é assíncrono por
// natureza; não existe driver Postgres síncrono confiável em JS puro). Por
// isso, diferente da promessa original do README ("trocar só este
// arquivo"), também foi necessário adicionar `await` nas chamadas dentro de
// server.js e scripts/seed.js — a troca de SQLite síncrono para Postgres
// assíncrono não dá pra esconder completamente atrás de uma única função.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[db] ATENÇÃO: variável de ambiente DATABASE_URL não definida. Configure-a com a connection string do Postgres antes de iniciar.');
}

// Bancos gerenciados (Render, Heroku, etc.) normalmente exigem SSL, mas com
// um certificado que a cadeia de CAs padrão do Node não reconhece — por
// isso `rejectUnauthorized: false` (aceita a conexão criptografada sem
// validar a cadeia do certificado). Para desenvolvimento local
// (localhost/127.0.0.1), SSL fica desligado.
const ehLocal = connectionString && /(localhost|127\.0\.0\.1)/.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: connectionString && !ehLocal ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // Erros em clientes ociosos do pool não devem derrubar o processo inteiro.
  console.error('[db] erro inesperado no pool do Postgres:', err.message);
});

// Traduz "?" posicionais (estilo node:sqlite / better-sqlite3) para
// "$1, $2, ..." (estilo pg). Simples e seguro para este projeto porque
// nenhuma das strings SQL usadas aqui contém "?" dentro de literais.
function paraPlaceholdersPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function prepare(sqlOriginal) {
  const sqlPg = paraPlaceholdersPg(sqlOriginal);
  // Todo INSERT ganha "RETURNING *" automaticamente, para que .run() consiga
  // devolver lastInsertRowid (equivalente ao que node:sqlite já devolvia)
  // sem precisar de uma segunda query. Como toda tabela deste projeto tem
  // uma coluna chamada "id", isso funciona igual nas cinco tabelas.
  const ehInsert = /^\s*insert/i.test(sqlOriginal) && !/returning/i.test(sqlOriginal);
  const sqlParaRun = ehInsert ? `${sqlPg} RETURNING *` : sqlPg;

  return {
    async run(...params) {
      const r = await pool.query(sqlParaRun, params);
      const primeiraLinha = r.rows[0];
      return {
        lastInsertRowid: primeiraLinha && 'id' in primeiraLinha ? primeiraLinha.id : undefined,
        changes: r.rowCount,
      };
    },
    async get(...params) {
      const r = await pool.query(sqlPg, params);
      return r.rows[0];
    },
    async all(...params) {
      const r = await pool.query(sqlPg, params);
      return r.rows;
    },
  };
}

async function exec(sql) {
  await pool.query(sql);
}

async function inicializarEsquema() {
  await exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      papel TEXT NOT NULL DEFAULT 'admin',
      criado_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS produtos (
      id SERIAL PRIMARY KEY,
      codigo TEXT NOT NULL UNIQUE,
      descricao TEXT NOT NULL,
      criado_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS etiquetas (
      id TEXT PRIMARY KEY,
      produto_id INTEGER REFERENCES produtos(id),
      quantidade INTEGER NOT NULL DEFAULT 0,
      localizacao TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ativo',
      version INTEGER NOT NULL DEFAULT 0,
      bateria_v REAL,
      rssi INTEGER,
      online INTEGER NOT NULL DEFAULT 0,
      ultima_comunicacao TEXT,
      ultima_atualizacao_aplicada TEXT,
      criado_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS historico (
      id SERIAL PRIMARY KEY,
      etiqueta_id TEXT NOT NULL,
      campo TEXT NOT NULL,
      valor_antigo TEXT,
      valor_novo TEXT,
      usuario TEXT,
      criado_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS atualizacoes (
      id TEXT PRIMARY KEY,
      etiqueta_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'enviado',
      criado_em TEXT NOT NULL,
      confirmado_em TEXT
    );
  `);
}

module.exports = { prepare, exec, inicializarEsquema, pool };
