'use strict';

// ---------------------------------------------------------------------------
// Ponte painel -> EMQX Cloud (broker MQTT de verdade, TLS 8883).
//
// A etiqueta física (ESP32) assina `alcabill/<dispositivo>/dados` e espera
// TEXTO PURO no formato `codigo|descricao|localizacao|status`, com retain.
// O mini-broker interno (src/broker/*) continua existindo só para o
// simulador; esta ponte é um caminho paralelo e independente.
//
// Variáveis de ambiente:
//   MQTT_URL        ex.: mqtts://xxxx.ala.us-east-1.emqxsl.com:8883
//   MQTT_USER       usuário do EMQX
//   MQTT_PASS       senha do EMQX (nunca é logada)
//   MAPA_ETIQUETAS  ex.: ALC-000001=etiqueta01,ALC-000002=etiqueta02
//                   (só compatibilidade: o vínculo etiqueta -> placa agora é
//                   a coluna `etiquetas.dispositivo`, editada pelo painel;
//                   o mapa é usado quando a coluna nunca foi definida/NULL e
//                   é copiado para a coluna no boot — ver migrarDispositivosDoMapa)
//
// Heartbeat da placa (placa -> painel): a placa publica, a cada vez que
// acorda (dorme 15 min), TEXTO retido QoS 0 em `alcabill/<dispositivo>/status`
// no formato `v1|<epoch>|<bateria_mV>|<rssi>` (ex.: v1|1762960000|3980|-61).
// A ponte assina `alcabill/+/status` e repassa a aoReceberStatus (opção de
// iniciarPonte), já interpretado por parseStatus().
//
// Sem MQTT_URL a ponte fica desativada e publicarNaEtiqueta() vira no-op.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');

let client = null;
let mapa = new Map();
let iniciada = false;
let avisouDesativada = false;

// "ALC-000001=etiqueta01, ALC-000002 = etiqueta02" -> Map
function parseMapa(texto) {
  const out = new Map();
  if (!texto) return out;
  for (const parte of String(texto).split(/[,;\n]/)) {
    const idx = parte.indexOf('=');
    if (idx === -1) continue;
    const id = parte.slice(0, idx).trim();
    const disp = parte.slice(idx + 1).trim();
    if (id && disp) out.set(id, disp);
  }
  return out;
}

function limparCampo(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos (e-paper sem acento)
    .replace(/[|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Função pura: monta `codigo|descricao|localizacao|status`.
function montarPayload({ codigo, descricao, localizacao, status } = {}) {
  return [
    limparCampo(codigo),
    limparCampo(descricao),
    limparCampo(localizacao),
    limparCampo(status).toUpperCase(),
  ].join('|');
}

// Nome da placa (o <dispositivo> de alcabill/<dispositivo>/dados).
const RE_DISPOSITIVO = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Função pura: normaliza (trim + minúsculas) e valida o nome da placa.
// Vazio é válido (= desvincular). Devolve { ok, valor } ou { ok: false, erro }.
function normalizarDispositivo(valor) {
  if (valor === null || valor === undefined) return { ok: true, valor: '' };
  if (typeof valor !== 'string' && typeof valor !== 'number') {
    return { ok: false, erro: 'Placa inválida.' };
  }
  const v = String(valor).trim().toLowerCase();
  if (v === '' || RE_DISPOSITIVO.test(v)) return { ok: true, valor: v };
  return {
    ok: false,
    erro: 'Placa inválida: use até 32 caracteres (letras sem acento, números, "-" ou "_"), começando por letra ou número. Ex.: etiqueta01',
  };
}

// Função pura: qual placa recebe a etiqueta.
//   - coluna preenchida          -> coluna            (origem 'coluna')
//   - coluna '' (desvinculada pelo painel) -> nenhuma (origem null)
//   - coluna NULL (nunca definida) -> MAPA_ETIQUETAS  (origem 'mapa'), se houver
// O '' explícito NÃO cai no mapa: senão "desvincular" no painel seria
// desfeito pelo fallback de compatibilidade.
function resolverDispositivo(id, coluna, mapaEtiquetas = new Map()) {
  if (coluna !== null && coluna !== undefined) {
    const c = String(coluna).trim();
    return c ? { dispositivo: c, origem: 'coluna' } : { dispositivo: null, origem: null };
  }
  const doMapa = mapaEtiquetas.get(String(id));
  return doMapa ? { dispositivo: doMapa, origem: 'mapa' } : { dispositivo: null, origem: null };
}

// Função pura: interpreta o heartbeat `v1|<epoch>|<bateria_mV>|<rssi>`.
// Devolve { epoch, bateriaMv, rssi } ou null (malformado / versão desconhecida).
const RE_INTEIRO = /^-?\d+$/;
function parseStatus(texto) {
  if (texto === null || texto === undefined) return null;
  const partes = String(texto).trim().split('|');
  if (partes.length !== 4 || partes[0] !== 'v1') return null;
  const nums = partes.slice(1).map((p) => p.trim());
  if (!nums.every((p) => RE_INTEIRO.test(p))) return null;
  const [epoch, bateriaMv, rssi] = nums.map(Number);
  if (epoch < 0 || bateriaMv < 0) return null;
  return { epoch, bateriaMv, rssi };
}

const TOPICO_STATUS = 'alcabill/+/status';
const RE_TOPICO_STATUS = /^alcabill\/([^/]+)\/status$/;

// Usa o mapa carregado do ambiente (em iniciarPonte ou, se a ponte ainda não
// subiu, lido na hora).
function dispositivoDaEtiqueta(id, coluna) {
  const m = iniciada ? mapa : parseMapa(process.env.MAPA_ETIQUETAS);
  return resolverDispositivo(id, coluna, m);
}

// opcoes.aoReceberStatus(dispositivo, { epoch, bateriaMv, rssi }, { retido })
// é chamado a cada heartbeat válido (pode ser async; erros são capturados
// aqui). `retido` = mensagem retida reentregue pelo broker, não ao vivo.
function iniciarPonte(env = process.env, { aoReceberStatus } = {}) {
  if (iniciada) return;
  iniciada = true;
  mapa = parseMapa(env.MAPA_ETIQUETAS);

  if (!env.MQTT_URL) {
    avisouDesativada = true;
    console.log('[emqx] ponte EMQX desativada (MQTT_URL não definida)');
    return;
  }

  let mqtt;
  try {
    mqtt = require('mqtt');
  } catch (err) {
    console.error('[emqx] pacote "mqtt" não encontrado — rode npm install. Ponte desativada.');
    return;
  }

  const clientId = 'alcabill-painel-' + crypto.randomBytes(4).toString('hex');
  try {
    client = mqtt.connect(env.MQTT_URL, {
      clientId,
      username: env.MQTT_USER || undefined,
      password: env.MQTT_PASS || undefined,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      clean: true,
    });
  } catch (err) {
    console.error('[emqx] falha ao criar cliente MQTT:', err.message);
    client = null;
    return;
  }

  let host = env.MQTT_URL;
  try { host = new URL(env.MQTT_URL).host; } catch (_) { /* mantém */ }

  client.on('connect', () => {
    console.log(`[emqx] conectado a ${host} como ${clientId}`);
    // 'connect' dispara também a cada reconexão; como a sessão é clean,
    // assinamos de novo toda vez.
    client.subscribe(TOPICO_STATUS, { qos: 0 }, (err) => {
      if (err) console.error(`[emqx] falha ao assinar ${TOPICO_STATUS}:`, err.message);
      else console.log(`[emqx] assinado ${TOPICO_STATUS}`);
    });
  });
  client.on('message', (topico, payload, packet) => {
    try {
      const m = RE_TOPICO_STATUS.exec(topico);
      if (!m) return;
      const texto = payload ? payload.toString('utf8') : '';
      if (!texto.trim()) return; // retido apagado
      const dispositivo = m[1];
      const dados = parseStatus(texto);
      if (!dados) {
        console.log(`[emqx] heartbeat inválido de ${dispositivo}: ${JSON.stringify(texto.slice(0, 80))}`);
        return;
      }
      // retain=true só chega quando o broker reentrega o retido (ao assinar,
      // ou seja, a cada (re)conexão do painel) — não é a placa falando agora.
      const retido = !!(packet && packet.retain);
      console.log(`[emqx] heartbeat${retido ? ' retido' : ''} de ${dispositivo}: epoch=${dados.epoch} bateria=${dados.bateriaMv}mV rssi=${dados.rssi}dBm`);
      if (typeof aoReceberStatus === 'function') {
        Promise.resolve(aoReceberStatus(dispositivo, dados, { retido })).catch((err) => {
          console.error(`[emqx] erro tratando heartbeat de ${dispositivo}:`, err && err.message);
        });
      }
    } catch (err) {
      console.error('[emqx] erro processando mensagem:', err && err.message);
    }
  });
  client.on('reconnect', () => console.log('[emqx] tentando reconectar...'));
  client.on('offline', () => console.log('[emqx] offline'));
  client.on('error', (err) => console.error('[emqx] erro:', err && err.message));
}

function avisarSemCliente() {
  if (!iniciada && !avisouDesativada) {
    avisouDesativada = true;
    console.log('[emqx] ponte EMQX desativada (não inicializada)');
  }
}

// `dispositivo` já vem resolvido pelo chamador (ver dispositivoDaEtiqueta).
function publicarNaEtiqueta({ id, dispositivo, codigo, descricao, localizacao, status } = {}) {
  try {
    if (!client) { avisarSemCliente(); return; }
    if (!dispositivo) {
      console.log(`[emqx] etiqueta ${id} sem placa vinculada — não publicado`);
      return;
    }
    const topico = `alcabill/${dispositivo}/dados`;
    const payload = montarPayload({ codigo, descricao, localizacao, status });
    client.publish(topico, payload, { qos: 1, retain: true }, (err) => {
      if (err) console.error(`[emqx] falha ao publicar em ${topico}:`, err.message);
      else console.log(`[emqx] publicado em ${topico}: ${payload}`);
    });
  } catch (err) {
    console.error('[emqx] erro ao publicar:', err && err.message);
  }
}

// Apaga a mensagem retida de uma placa que deixou de estar vinculada: pela
// especificação MQTT, um PUBLISH retido com payload vazio (zero bytes) remove
// o retained do tópico no broker. Sem isso, a placa antiga continuaria
// recebendo o último estado da etiqueta ao reconectar.
function limparRetido(dispositivo) {
  try {
    if (!client) { avisarSemCliente(); return; }
    if (!dispositivo) return;
    const topico = `alcabill/${dispositivo}/dados`;
    client.publish(topico, '', { qos: 1, retain: true }, (err) => {
      if (err) console.error(`[emqx] falha ao limpar retido em ${topico}:`, err.message);
      else console.log(`[emqx] retido limpo em ${topico}`);
    });
  } catch (err) {
    console.error('[emqx] erro ao limpar retido:', err && err.message);
  }
}

module.exports = {
  iniciarPonte,
  publicarNaEtiqueta,
  limparRetido,
  dispositivoDaEtiqueta,
  resolverDispositivo,
  normalizarDispositivo,
  montarPayload,
  parseStatus,
  parseMapa,
  limparCampo,
};
