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
const emqx = require('./emqx-bridge');

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

  // Ponte para a etiqueta física no EMQX (texto puro, retained). Nunca pode
  // quebrar a resposta HTTP — publicarNaEtiqueta já captura erros, mas o
  // try/catch aqui garante isso mesmo se algo mudar lá dentro. A placa vem da
  // coluna `dispositivo` (definida pelo painel); MAPA_ETIQUETAS só como
  // fallback de compatibilidade quando a coluna é NULL.
  try {
    const { dispositivo } = emqx.dispositivoDaEtiqueta(etiquetaId, etiqueta.dispositivo);
    emqx.publicarNaEtiqueta({
      id: etiquetaId,
      dispositivo,
      codigo: payload.codigo,
      descricao: payload.descricao,
      localizacao: payload.localizacao,
      status: payload.status,
    });
  } catch (err) {
    console.error('[emqx] erro inesperado na ponte:', err && err.message);
  }
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

// Status de estoque aceitos para uma etiqueta (cabem na caixinha do e-paper).
const STATUS_VALIDOS = ['ok', 'baixo', 'falta'];

// Valida o campo `dispositivo` vindo do corpo de POST/PUT de etiqueta.
// Devolve { erro: [statusHttp, mensagem] } ou { valor } ('' = desvincular).
// `undefined` (campo ausente) não chega aqui.
async function validarDispositivo(valorBruto, usuario, etiquetaIdAtual) {
  if (usuario.papel !== 'admin') {
    return { erro: [403, 'Só administradores podem vincular ou trocar a placa de uma etiqueta.'] };
  }
  const n = emqx.normalizarDispositivo(valorBruto);
  if (!n.ok) return { erro: [400, n.erro] };
  if (n.valor) {
    const outra = await db.prepare('SELECT id FROM etiquetas WHERE dispositivo = ? AND id <> ?')
      .get(n.valor, etiquetaIdAtual || '');
    if (outra) return { erro: [409, `A placa ${n.valor} já está vinculada à etiqueta ${outra.id}.`] };
  }
  return { valor: n.valor };
}

// Violação do índice único etiquetas_dispositivo_unico (corrida entre duas
// requisições que passaram pela checagem acima ao mesmo tempo).
function ehConflitoDispositivo(err) {
  return err && err.code === '23505' && String(err.constraint || err.message || '').includes('etiquetas_dispositivo_unico');
}

function sendJson(res, statusCode, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

// Cookie da sessão. `Secure` só quando a requisição chegou por HTTPS: no
// Render o TLS termina no proxy, que avisa via x-forwarded-proto; localmente
// (http://localhost) o cookie precisa funcionar sem Secure.
function ehHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https' || Boolean(req.socket && req.socket.encrypted);
}

function cookieSessao(req, sid) {
  return `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${auth.DURACAO_SESSAO_S}` + (ehHttps(req) ? '; Secure' : '');
}

function cookieApagado(req) {
  return 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' + (ehHttps(req) ? '; Secure' : '');
}

// Assíncrono: a sessão agora vem do Postgres (tabela `sessoes`), já com o
// usuário junto (id, nome, email, papel). Se a validade foi renovada nesta
// requisição, o cookie é reenviado com Max-Age cheio de novo.
async function requireLogin(req, res) {
  const cookies = parseCookies(req);
  const session = cookies.sid ? await auth.getSession(cookies.sid) : null;
  if (!session) {
    sendJson(res, 401, { erro: 'não autenticado' });
    return null;
  }
  if (session.renovada) res.setHeader('Set-Cookie', cookieSessao(req, session.sid));
  return session;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

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
      const token = await auth.createSession(user.id);
      return sendJson(res, 200, { nome: user.nome, email: user.email, papel: user.papel }, {
        'Set-Cookie': cookieSessao(req, token),
      });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.sid) await auth.destroySession(cookies.sid);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieApagado(req) });
    }

    const session = await requireLogin(req, res);
    if (!session) return; // requireLogin já respondeu 401
    // id, nome, email, papel — já vieram na mesma query da sessão.
    const usuario = session.usuario;

    if (pathname === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, { nome: usuario.nome, email: usuario.email, papel: usuario.papel });
    }

    if (pathname === '/api/senha' && req.method === 'PUT') {
      const { senha_atual, senha_nova } = await readBody(req);
      if (!senha_atual || !senha_nova) return sendJson(res, 400, { erro: 'informe a senha atual e a nova senha' });
      if (senha_nova.length < 6) return sendJson(res, 400, { erro: 'a nova senha deve ter pelo menos 6 caracteres' });
      const credenciais = await db.prepare('SELECT senha_hash, salt FROM usuarios WHERE id = ?').get(usuario.id);
      if (!credenciais || !auth.verifyPassword(senha_atual, credenciais.senha_hash, credenciais.salt)) {
        return sendJson(res, 401, { erro: 'senha atual incorreta' });
      }
      const { hash, salt } = auth.hashPassword(senha_nova);
      await db.prepare('UPDATE usuarios SET senha_hash = ?, salt = ? WHERE id = ?').run(hash, salt, usuario.id);
      // Desloga os outros aparelhos/navegadores deste usuário; mantém a sessão atual.
      await auth.destroyOtherSessions(usuario.id, session.sid);
      return sendJson(res, 200, { ok: true });
    }

    // ---- usuários (gerenciado só por admin — ex.: dar acesso a mais gente
    // no mesmo estoque, como um colega/amigo) ----
    if (pathname === '/api/usuarios' && req.method === 'GET') {
      if (usuario.papel !== 'admin') return sendJson(res, 403, { erro: 'só administradores podem ver os usuários' });
      const rows = await db.prepare('SELECT id, nome, email, papel, criado_em FROM usuarios ORDER BY id').all();
      return sendJson(res, 200, rows);
    }
    if (pathname === '/api/usuarios' && req.method === 'POST') {
      if (usuario.papel !== 'admin') return sendJson(res, 403, { erro: 'só administradores podem criar novos usuários' });
      const { nome, email, senha } = await readBody(req);
      if (!nome || !email || !senha) return sendJson(res, 400, { erro: 'nome, e-mail e senha são obrigatórios' });
      if (senha.length < 6) return sendJson(res, 400, { erro: 'a senha deve ter pelo menos 6 caracteres' });
      const existente = await db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
      if (existente) return sendJson(res, 400, { erro: 'já existe um usuário com esse e-mail' });
      const { hash, salt } = auth.hashPassword(senha);
      const info = await db.prepare(
        'INSERT INTO usuarios (nome, email, senha_hash, salt, papel, criado_em) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(nome, email, hash, salt, 'usuario', new Date().toISOString());
      return sendJson(res, 201, { id: Number(info.lastInsertRowid), nome, email, papel: 'usuario' });
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
    const produtoMatch = pathname.match(/^\/api\/produtos\/(\d+)$/);
    if (produtoMatch && req.method === 'PUT') {
      const produtoId = Number(produtoMatch[1]);
      const { codigo, descricao } = await readBody(req);
      if (!codigo || !descricao) return sendJson(res, 400, { erro: 'código e descrição são obrigatórios' });
      const produto = await db.prepare('SELECT * FROM produtos WHERE id = ?').get(produtoId);
      if (!produto) return sendJson(res, 404, { erro: 'produto não encontrado' });
      await db.prepare('UPDATE produtos SET codigo = ?, descricao = ? WHERE id = ?').run(codigo, descricao, produtoId);
      return sendJson(res, 200, await db.prepare('SELECT * FROM produtos WHERE id = ?').get(produtoId));
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
      const { produto_id, localizacao = '', dispositivo: dispositivoBruto } = await readBody(req);
      // Campo ausente -> NULL (a ponte ainda pode usar MAPA_ETIQUETAS).
      let dispositivo = null;
      if (dispositivoBruto !== undefined) {
        const v = await validarDispositivo(dispositivoBruto, usuario, null);
        if (v.erro) return sendJson(res, v.erro[0], { erro: v.erro[1] });
        dispositivo = v.valor || null;
      }
      const id = await proximoSerial();
      try {
        await db.prepare(`
          INSERT INTO etiquetas (id, produto_id, localizacao, status, version, online, criado_em, dispositivo)
          VALUES (?, ?, ?, 'ok', 1, 0, ?, ?)
        `).run(id, produto_id || null, localizacao, new Date().toISOString(), dispositivo);
      } catch (err) {
        if (ehConflitoDispositivo(err)) return sendJson(res, 409, { erro: `A placa ${dispositivo} já está vinculada a outra etiqueta.` });
        throw err;
      }
      await registrarHistorico(id, 'criação', null, `etiqueta ${id} criada`, usuario.nome);
      if (dispositivo) await registrarHistorico(id, 'dispositivo', null, dispositivo, usuario.nome);
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
        if (alteracoes.status !== undefined && !STATUS_VALIDOS.includes(alteracoes.status)) {
          return sendJson(res, 400, { erro: `status inválido: use ${STATUS_VALIDOS.join(', ')}` });
        }
        // Placa vinculada: só admin; validada antes de gravar qualquer campo.
        let dispositivoNovo; // undefined = não mexer
        if (alteracoes.dispositivo !== undefined) {
          const v = await validarDispositivo(alteracoes.dispositivo, usuario, etiquetaId);
          if (v.erro) return sendJson(res, v.erro[0], { erro: v.erro[1] });
          dispositivoNovo = v.valor;
        }
        // Placa efetiva hoje (coluna ou fallback do mapa) — é dela que o
        // retido precisa ser limpo se o vínculo mudar.
        const dispositivoAntigo = emqx.dispositivoDaEtiqueta(etiquetaId, etiqueta.dispositivo).dispositivo;
        let trocouPlaca = false;
        // Grava se o valor guardado muda. Caso especial: coluna NULL com placa
        // vinda do MAPA_ETIQUETAS — mandar '' precisa gravar '' para
        // desvincular de verdade (senão o fallback continuaria publicando).
        const guardado = etiqueta.dispositivo;
        const gravar = dispositivoNovo !== undefined && (guardado === null || guardado === undefined
          ? (dispositivoNovo !== '' || !!dispositivoAntigo)
          : dispositivoNovo !== guardado);
        if (gravar) {
          try {
            await db.prepare('UPDATE etiquetas SET dispositivo = ? WHERE id = ?').run(dispositivoNovo, etiquetaId);
          } catch (err) {
            if (ehConflitoDispositivo(err)) return sendJson(res, 409, { erro: `A placa ${dispositivoNovo} já está vinculada a outra etiqueta.` });
            throw err;
          }
          await registrarHistorico(etiquetaId, 'dispositivo', etiqueta.dispositivo || null, dispositivoNovo || '(nenhuma)', usuario.nome);
          trocouPlaca = (dispositivoAntigo || '') !== dispositivoNovo;
        }
        const campos = ['localizacao', 'status'];
        let mudou = false;
        for (const campo of campos) {
          if (alteracoes[campo] !== undefined && String(alteracoes[campo]) !== String(etiqueta[campo])) {
            await registrarHistorico(etiquetaId, campo, etiqueta[campo], alteracoes[campo], usuario.nome);
            await db.prepare(`UPDATE etiquetas SET ${campo} = ? WHERE id = ?`).run(alteracoes[campo], etiquetaId);
            mudou = true;
          }
        }
        if (trocouPlaca && dispositivoAntigo) {
          try { emqx.limparRetido(dispositivoAntigo); } catch (err) { console.error('[emqx] erro inesperado na ponte:', err && err.message); }
        }
        if (mudou) {
          await db.prepare('UPDATE etiquetas SET version = version + 1 WHERE id = ?').run(etiquetaId);
        }
        // Placa nova recebe o estado atual mesmo se só o vínculo mudou.
        if (mudou || trocouPlaca) await publicarComando(etiquetaId);
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
// Limpeza de sessões expiradas: na subida e a cada ~6h. unref() para o timer
// não segurar o processo vivo sozinho. Erro aqui só loga — não é crítico.
const LIMPEZA_SESSOES_MS = 6 * 60 * 60 * 1000;
async function limparSessoes() {
  try {
    const n = await auth.limparSessoesExpiradas();
    if (n) console.log(`[auth] ${n} sessão(ões) expirada(s) removida(s)`);
  } catch (err) {
    console.error('[auth] erro limpando sessões expiradas:', err.message);
  }
}

async function iniciar() {
  await db.inicializarEsquema();
  // Compatibilidade: copia MAPA_ETIQUETAS para a coluna `dispositivo` onde
  // ela nunca foi definida. Falha aqui só loga — não impede o painel de subir.
  try {
    await db.migrarDispositivosDoMapa(emqx.parseMapa(process.env.MAPA_ETIQUETAS));
  } catch (err) {
    console.error('[startup] erro migrando MAPA_ETIQUETAS:', err && err.message);
  }
  await garantirUsuarioAdmin();
  await limparSessoes();
  setInterval(limparSessoes, LIMPEZA_SESSOES_MS).unref();
  broker.listen(BROKER_PORT);
  conectarBackendMqtt();
  emqx.iniciarPonte();
  server.listen(HTTP_PORT, () => {
    console.log(`[http] painel ALCABILL em http://localhost:${HTTP_PORT}`);
    console.log('Se ainda não criou um usuário, rode: npm run seed');
  });
}

iniciar().catch((err) => {
  console.error('[startup] falha ao iniciar (verifique DATABASE_URL):', err);
  process.exit(1);
});
