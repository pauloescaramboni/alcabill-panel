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

// Duas formas de configurar a conexão:
//
// 1) Variáveis PG* (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT...) —
//    é o formato do .env que o Neon gera. Têm PRIORIDADE: quando PGHOST está
//    definida, DATABASE_URL é ignorada (no Render ainda pode existir uma
//    DATABASE_URL antiga apontando para o banco apagado). Nesse caso o Pool
//    é criado sem connectionString e o próprio `pg` lê as PG* do ambiente.
// 2) DATABASE_URL — connection string completa (comportamento original).
//
// Bancos gerenciados (Render, Neon, Heroku, etc.) normalmente exigem SSL,
// mas com um certificado que a cadeia de CAs padrão do Node pode não
// reconhecer — por isso `rejectUnauthorized: false` (aceita a conexão
// criptografada sem validar a cadeia do certificado). Para desenvolvimento
// local (localhost/127.0.0.1), SSL fica desligado. O `ssl` é sempre passado
// explicitamente, então ele prevalece sobre um eventual PGSSLMODE no
// ambiente (o `pg` só consulta PGSSLMODE quando a opção `ssl` não é passada).
const RE_LOCAL = /(localhost|127\.0\.0\.1)/;
const pgHost = process.env.PGHOST;
const connectionString = process.env.DATABASE_URL;

let configPool;
if (pgHost) {
  console.log(`[db] usando variáveis PG* (host: ${pgHost})`);
  configPool = { ssl: RE_LOCAL.test(pgHost) ? false : { rejectUnauthorized: false } };
} else if (connectionString) {
  const ehLocal = RE_LOCAL.test(connectionString);
  configPool = { connectionString, ssl: ehLocal ? false : { rejectUnauthorized: false } };
} else {
  console.error('[db] ATENÇÃO: nenhuma configuração de banco encontrada. Defina as variáveis PG* do Neon (PGHOST, PGUSER, PGPASSWORD, PGDATABASE) ou a DATABASE_URL com a connection string do Postgres antes de iniciar.');
  configPool = {};
}
const pool = new Pool(configPool);

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
      status TEXT NOT NULL DEFAULT 'ok',
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

  // Migração dos status antigos (ativo/manutenção/inativo) para os status de
  // estoque (ok/baixo/falta). O CREATE TABLE IF NOT EXISTS acima não altera
  // uma tabela que já existe em produção, então o default e os dados antigos
  // são ajustados aqui. Tudo é idempotente: rodar de novo não muda nada.
  await exec(`
    ALTER TABLE etiquetas ALTER COLUMN status SET DEFAULT 'ok';
    UPDATE etiquetas SET status = 'ok' WHERE status = 'ativo';
    UPDATE etiquetas SET status = 'falta' WHERE status = 'inativo';
    UPDATE etiquetas SET status = 'baixo' WHERE status IN ('manutenção', 'manutencao');
  `);

  // Sessões de login (antes ficavam num Map em memória e se perdiam a cada
  // reinício do Render). Tabela nova, então usa TIMESTAMPTZ de verdade em vez
  // das datas em TEXT das outras tabelas. Acessada direto via pool.query em
  // src/auth.js (não pelo shim prepare(), que acrescentaria RETURNING * aos
  // INSERTs pensando numa coluna "id" que esta tabela não tem).
  await exec(`
    CREATE TABLE IF NOT EXISTS sessoes (
      sid TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      expira_em TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessoes_expira_em_idx ON sessoes (expira_em);
    CREATE INDEX IF NOT EXISTS sessoes_usuario_id_idx ON sessoes (usuario_id);
  `);

  // Placa física vinculada a cada etiqueta (o <dispositivo> do tópico
  // alcabill/<dispositivo>/dados no EMQX). Editada pelo painel (só admin).
  //   NULL -> nunca definida (a ponte ainda aceita MAPA_ETIQUETAS como fallback)
  //   ''   -> desvinculada de propósito pelo painel (não publica)
  // O índice único parcial impede duas etiquetas na mesma placa, ignorando
  // NULL e ''. Idempotente.
  await exec(`
    ALTER TABLE etiquetas ADD COLUMN IF NOT EXISTS dispositivo TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS etiquetas_dispositivo_unico
      ON etiquetas (dispositivo) WHERE dispositivo IS NOT NULL AND dispositivo <> '';
  `);
}

// Copia o MAPA_ETIQUETAS (variável de ambiente antiga) para a coluna
// `dispositivo`, só onde ela nunca foi definida (NULL). Não sobrescreve o que
// foi definido pelo painel — nem um "desvincular" (''), senão a desvinculação
// seria desfeita a cada reinício. Conflito de unicidade (placa já usada por
// outra etiqueta) só gera log. Erros não derrubam o boot.
async function migrarDispositivosDoMapa(mapa) {
  let migradas = 0;
  for (const [id, dispositivoBruto] of mapa) {
    const dispositivo = String(dispositivoBruto).trim().toLowerCase();
    try {
      const r = await pool.query(
        'UPDATE etiquetas SET dispositivo = $2 WHERE id = $1 AND dispositivo IS NULL',
        [id, dispositivo]
      );
      migradas += r.rowCount;
    } catch (err) {
      if (err && err.code === '23505') {
        console.log(`[db] MAPA_ETIQUETAS: placa ${dispositivo} já vinculada a outra etiqueta — ${id} não migrada`);
      } else {
        console.error(`[db] MAPA_ETIQUETAS: erro migrando ${id}=${dispositivo}:`, err && err.message);
      }
    }
  }
  if (migradas) console.log(`[db] MAPA_ETIQUETAS: ${migradas} vínculo(s) copiado(s) para a coluna dispositivo`);
  return migradas;
}

module.exports = { prepare, exec, inicializarEsquema, migrarDispositivosDoMapa, pool };
