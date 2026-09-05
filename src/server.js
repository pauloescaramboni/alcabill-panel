'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('./db');
const auth = require('./auth');
const topics = require('./topics');
const { createBroker } = require('./broker/server');
const brokerClient = require('./broker/client');

const HTTP_PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const BROKER_PORT = process.env.BROKER_PORT ? Number(process.env.BROKER_PORT) : 1883;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// 1) Mini-broker (TCP) — ver src/broker/server.js para o porquê de existir.
//    O backend se conecta nele como um cliente MQTT normal se conectaria.
//
//    IMPORTANTE (bug real, achado no primeiro deploy no Render): antes desta
//    versão, o backendMqtt.connect() rodava aqui em cima, no carregamento do
//    módulo — mas broker.listen() só rodava dentro de iniciar(), depois do
//    await db.inicializarEsquema() (movido pra lá de propósito, pra garantir
//    que o schema existe antes de qualquer mensagem ser processada). Isso
//    criava uma corrida: o cliente tentava conectar ANTES do broker estar de
//    fato escutando na porta, e como o socket de erro não tinha listener
//    (ver client.js), o ECONNREFUSED derrubava o processo inteiro assim que
//    o Postgres demorasse um pouquinho mais que zero milissegundos pra
//    responder — o que, contra um banco de verdade pela rede (diferente do
//    node:sqlite local, que era instantâneo), acontece sempre. Corrigido
//    conectando o backend só depois de broker.listen(), dentro de iniciar().
// ---------------------------------------------------------------------------
const broker = createBroker();
let backendMqtt;

function conectarBackendMqtt() {
  backendMqtt = brokerClient.connect({ port: BROKER_PORT, clientId: 'backend' });

  backendMqtt.on('connect', () => {
    backendMqtt.subscribe(topics.WILD.status);
    backendMqtt.subscribe(topics.WILD.confirmacao);
    backendMqtt.subscribe(topics.WILD.telemetria);
    console.log('[backend] conectado ao mini-broker e assinando status/confirmação/telemetria de todas as etiquetas');
  });

  // Sem isso, um erro de socket derruba o processo inteiro (EventEmitter do
  // Node lança exceção quando 'error' é emitido sem nenhum listener). Como o
  // broker é interno ao mesmo processo (conexão local, não é uma rede de
  // verdade), na prática só deveria disparar se o processo já estiver
  // morrendo por outro motivo — mas custa nada logar em vez de deixar
  // implícito.
  backendMqtt.on('error', (err) => {
    console.error('[backend] erro na conexão com o mini-broker:', err.message);
  });

  // Assíncrono + try/catch: mensagens chegam de fora (etiquetas reais ou
  // simuladas) e o Postgres agora responde de forma assíncrona — um erro
  // pontual de banco (ex.: uma reconexão do pool) não pode derrubar o
  // processo inteiro nem travar o recebimento das próximas mensagens.
  backendMqtt.on('message', async (topic, payload) => {
    try {
      const etiquetaId = topics.etiquetaIdFromTopic(topic);
      const agora = new Date().toISOString();

      if (topic.endsWith('/status')) {
        await db.prepare('UPDATE etiquetas SET online = ?, ultima_comunicacao = ? WHERE id = ?')
          .run(payload.state === 'online' ? 1 : 0, agora, etiquetaId);
        console.log(`[backend] status de ${etiquetaId}: ${payload.state}`);
      } else if (topic.endsWith('/confirmacao')) {
        const row = await db.prepare('SELECT * FROM atualizacoes WHERE id = ?').get(payload.update_id);
        if (row) {
          await db.prepare('UPDATE atualizacoes SET status = ?, confirmado_em = ? WHERE id = ?')
            .run('confirmado', agora, payload.update_id);
        }
        await db.prepare('UPDATE etiquetas SET online = 1, ultima_comunicacao = ?, ultima_atualizacao_aplicada = ? WHERE id = ?')
          .run(agora, agora, etiquetaId);
        console.log(`[backend] confirmação de ${etiquetaId}: update ${payload.update_id} (v${payload.version}) status=${payload.status}`);
      } else if (topic.endsWith('/telemetria')) {
        await db.prepare('UPDATE etiquetas SET bateria_v = ?, rssi = ?, online = 1, ultima_comunicacao = ? WHERE id = ?')
          .run(payload.bateria_v, payload.rssi, agora, etiquetaId);
      }
    } catch (err) {
      console.error('[backend] erro processando mensagem do broker:', topic, err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// 2) Regras de negócio (o que a auditoria chama de "fluxo de confirmação em
//    três fases": enviado -> recebido -> aplicado)
// ---------------------------------------------------------------------------

async function proximoSerial() {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM etiquetas').get();
  // Importante: COUNT(*) no Postgres devolve bigint, e o driver `pg` traz
  // bigint como STRING em JS (pra não perder precisão em números muito
  // grandes) — sem o Number(...) aqui, "5" + 1 vira "51" (concatenação de
  // texto), não 6. Isso não existia no node:sqlite, que já devolvia number.
  const n = Number(row.n) + 1;
  return 'ALC-' + String(n).padStart(6, '0');
}

async function registrarHistorico(etiquetaId, campo, antigo, novo, usuario) {
  if (String(antigo) === String(novo)) return;
  await db.prepare(
    'INSERT INTO historico (etiqueta_id, campo, valor_antigo, valor_novo, usuario, criado_em) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(etiquetaId, campo, antigo == null ? null : String(antigo), novo == null ? null : String(novo), usuario, new Date().toISOString());
}

// Publica o "comando" (estado atual da etiqueta) via mini-broker, retained + QoS1,
// e registra a linha em `atualizacoes` com status "enviado" — fase 1 do fluxo.
async function publicarComando(etiquetaId) {
  const etiqueta = await db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(etiquetaId);
  const produto = etiqueta.produto_id ? await db.prepare('SELECT * FROM produtos WHERE id = ?').get(etiqueta.produto_id) : null;
  const updateId = crypto.randomUUID();
  const payload = {
    update_id: updateId,
    version: etiqueta.version,
    codigo: produto ? produto.codigo : null,
    descricao: produto ? produto.descricao : null,
    quantidade: etiqueta.quantidade,
    localizacao: etiqueta.localizacao,
    status: etiqueta.status,
    timestamp: new Date().toISOString(),
  };
  await db.prepare(
    'INSERT INTO atualizacoes (id, etiqueta_id, version, payload, status, criado_em) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(updateId, etiquetaId, etiqueta.version, JSON.stringify(payload), 'enviado', new Date().toISOString());

  backendMqtt.publish(topics.comando(etiquetaId), payload, { retain: true, qos: 1 }, () => {
    console.log(`[backend] comando ${updateId} (v${payload.version}) confirmado como entregue ao broker para ${etiquetaId}`);
  });
  return updateId;
}

// ---------------------------------------------------------------------------
// 3) Servidor HTTP: API JSON (/api/...) + arquivos estáticos do painel (public/)
// ---------------------------------------------------------------------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

function requireLogin(req, res) {
  const cookies = parseCookies(req);
  const session = cookies.sid && auth.getSession(cookies.sid);
  if (!session) {
    sendJson(res, 401, { erro: 'não autenticado' });
    return null;
  }
  return session;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: qualquer rota desconhecida sem extensão volta pro index.html
      if (!path.extname(pathname)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
          if (err2) { res.writeHead(404); return res.end('não encontrado'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(data2);
        });
      }
      res.writeHead(404); return res.end('não encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    // ---- auth ----
    if (pathname === '/api/login' && req.method === 'POST') {
      const { email, senha } = await readBody(req);
      const user = await db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email || '');
      if (!user || !auth.verifyPassword(senha || '', user.senha_hash, user.salt)) {
        return sendJson(res, 401, { erro: 'email ou senha inválidos' });
      }
      const token = auth.createSession(user.id);
      return sendJson(res, 200, { nome: user.nome, email: user.email, papel: user.papel }, {
        'Set-Cookie': `sid=${token}; HttpOnly; Path=/; SameSite=Lax`,
      });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.sid) auth.destroySession(cookies.sid);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
    }

    const session = requireLogin(req, res);
    if (!session) return; // requireLogin já respondeu 401
    const usuario = await db.prepare('SELECT * FROM usuarios WHERE id = ?').get(session.userId);

    if (pathname === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, { nome: usuario.nome, email: usuario.email, papel: usuario.papel });
    }

    // ---- produtos ----
    if (pathname === '/api/produtos' && req.method === 'GET') {
      return sendJson(res, 200, await db.prepare('SELECT * FROM produtos ORDER BY id DESC').all());
    }
    if (pathname === '/api/produtos' && req.method === 'POST') {
      const { codigo, descricao } = await readBody(req);
      if (!codigo || !descricao) return sendJson(res, 400, { erro: 'código e descrição são obrigatórios' });
      const info = await db.prepare('INSERT INTO produtos (codigo, descricao, criado_em) VALUES (?, ?, ?)')
        .run(codigo, descricao, new Date().toISOString());
      return sendJson(res, 201, await db.prepare('SELECT * FROM produtos WHERE id = ?').get(Number(info.lastInsertRowid)));
    }

    // ---- etiquetas ----
    if (pathname === '/api/etiquetas' && req.method === 'GET') {
      const rows = await db.prepare(`
        SELECT e.*, p.codigo AS produto_codigo, p.descricao AS produto_descricao
        FROM etiquetas e LEFT JOIN produtos p ON p.id = e.produto_id
        ORDER BY e.criado_em DESC
      `).all();
      return sendJson(res, 200, rows);
    }

    if (pathname === '/api/etiquetas' && req.method === 'POST') {
      const { produto_id, quantidade = 0, localizacao = '' } = await readBody(req);
      const id = await proximoSerial();
      await db.prepare(`
        INSERT INTO etiquetas (id, produto_id, quantidade, localizacao, status, version, online, criado_em)
        VALUES (?, ?, ?, ?, 'ativo', 1, 0, ?)
      `).run(id, produto_id || null, quantidade, localizacao, new Date().toISOString());
      await registrarHistorico(id, 'criação', null, `etiqueta ${id} criada`, usuario.nome);
      await publicarComando(id);
      return sendJson(res, 201, await db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(id));
    }

    const etiquetaMatch = pathname.match(/^\/api\/etiquetas\/([^/]+)(\/(historico|reenviar))?$/);
    if (etiquetaMatch) {
      const etiquetaId = decodeURIComponent(etiquetaMatch[1]);
      const sub = etiquetaMatch[3];
      const etiqueta = await db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(etiquetaId);
      if (!etiqueta) return sendJson(res, 404, { erro: 'etiqueta não encontrada' });

      if (!sub && req.method === 'GET') return sendJson(res, 200, etiqueta);

      if (!sub && req.method === 'PUT') {
        const alteracoes = await readBody(req);
        const campos = ['quantidade', 'localizacao', 'status'];
        let mudou = false;
        for (const campo of campos) {
          if (alteracoes[campo] !== undefined && String(alteracoes[campo]) !== String(etiqueta[campo])) {
            await registrarHistorico(etiquetaId, campo, etiqueta[campo], alteracoes[campo], usuario.nome);
            await db.prepare(`UPDATE etiquetas SET ${campo} = ? WHERE id = ?`).run(alteracoes[campo], etiquetaId);
            mudou = true;
          }
        }
        if (mudou) {
          await db.prepare('UPDATE etiquetas SET version = version + 1 WHERE id = ?').run(etiquetaId);
          await publicarComando(etiquetaId);
        }
        return sendJson(res, 200, await db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(etiquetaId));
      }

      if (sub === 'reenviar' && req.method === 'POST') {
        const updateId = await publicarComando(etiquetaId);
        return sendJson(res, 200, { ok: true, update_id: updateId });
      }

      if (sub === 'historico' && req.method === 'GET') {
        return sendJson(res, 200, await db.prepare('SELECT * FROM historico WHERE etiqueta_id = ? ORDER BY id DESC').all(etiquetaId));
      }
    }

    sendJson(res, 404, { erro: 'rota não encontrada' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { erro: 'erro interno', detalhe: String(err.message || err) });
  }
});

// Cria o usuário admin padrão se o banco ainda não tiver nenhum usuário —
// mesma lógica de scripts/seed.js, só que rodando sozinha na subida do
// servidor. Necessário porque, no Render (free tier), não tem um jeito fácil
// de rodar "npm run seed" à parte contra o Postgres de produção (sem shell/
// job avulso disponível) — então o próprio boot garante que sempre existe
// pelo menos um login válido. Idempotente: se já existe usuário, não faz nada.
async function garantirUsuarioAdmin() {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM usuarios').get();
  if (Number(row.n) > 0) return;

  const email = process.env.ADMIN_EMAIL || 'admin@alcabill.local';
  const senha = process.env.ADMIN_SENHA || 'alcabill123';
  const { hash, salt } = auth.hashPassword(senha);
  await db.prepare(
    'INSERT INTO usuarios (nome, email, senha_hash, salt, papel, criado_em) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('Administrador', email, hash, salt, 'admin', new Date().toISOString());

  console.log(`[startup] nenhum usuário existia — criei o admin padrão automaticamente: ${email}`);
  console.log('[startup] troque essa senha assim que logar pela primeira vez.');
}

// ---------------------------------------------------------------------------
// 4) Inicialização: garante o schema do Postgres antes de aceitar qualquer
//    conexão (broker ou HTTP) — assim nenhuma mensagem/requisição chega
//    antes das tabelas existirem.
// ---------------------------------------------------------------------------
async function iniciar() {
  await db.inicializarEsquema();
  await garantirUsuarioAdmin();
  broker.listen(BROKER_PORT);
  conectarBackendMqtt();
  server.listen(HTTP_PORT, () => {
    console.log(`[http] painel ALCABILL em http://localhost:${HTTP_PORT}`);
    console.log('Se ainda não criou um usuário, rode: npm run seed');
  });
}

iniciar().catch((err) => {
  console.error('[startup] falha ao iniciar (verifique DATABASE_URL):', err);
  process.exit(1);
});
