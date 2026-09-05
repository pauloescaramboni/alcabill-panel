'use strict';

/*
 * MINI-BROKER — um "MQTT-like broker" de ~150 linhas, feito só com net.createServer
 * (módulo nativo do Node, sem nenhuma dependência de terceiros).
 *
 * POR QUE ISTO EXISTE (leia antes de estranhar):
 * Este sandbox de desenvolvimento não tem acesso ao registro do npm (registry.npmjs.org
 * está fora da lista de hosts permitidos na política de rede desta conta/sessão — toda
 * tentativa de `npm install` retorna 403 "host_not_allowed"). Ou seja, não foi possível
 * instalar `mqtt`, `aedes`, nem nenhuma outra biblioteca.
 *
 * A solução foi implementar, só com módulos nativos do Node (net, node:sqlite, crypto),
 * um broker mínimo que reproduz o CONTRATO que a auditoria técnica definiu para o MQTT:
 * tópicos, mensagens retidas (retain), confirmação estilo QoS1 (puback), e Last Will
 * and Testament (mensagem publicada automaticamente se o cliente cair sem avisar).
 *
 * O QUE ISTO NÃO É: não é o protocolo binário MQTT 3.1.1/5.0 de verdade. Um firmware real
 * rodando MQTT (biblioteca PubSubClient/esp-mqtt no ESP32) NÃO vai conseguir falar com este
 * broker — ele fala "JSON por linha" sobre TCP, não MQTT de fato.
 *
 * COMO MIGRAR PARA MQTT DE VERDADE (quando este código rodar num ambiente com internet):
 *   1) `npm install mqtt aedes` (ou suba um Mosquitto separado)
 *   2) Troque só o arquivo src/broker/client.js por um wrapper em cima do pacote `mqtt`
 *      (mesma interface pública: connect/subscribe/publish/onMessage) — nada em
 *      src/server.js ou no simulador precisa mudar, pois ambos só usam essa interface.
 *   3) Troque este server.js por `require('aedes')()` + `net.createServer(aedes.handle)`,
 *      ou aponte os clientes para um Mosquitto real (mqtt://host:1883).
 */

const net = require('net');
const { attachFraming, send } = require('./protocol');

function topicMatches(pattern, topic) {
  const p = pattern.split('/');
  const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true; // '#' precisa ser o último segmento e casa com o resto
    if (i >= t.length) return false;
    if (p[i] === '+') continue;
    if (p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

function createBroker({ logger = console } = {}) {
  const retained = new Map(); // topic -> payload
  const subscribers = new Map(); // socketId -> { socket, clientId, topics:Set, will }
  let nextId = 1;

  function fanOut(topic, payload, retain) {
    for (const sub of subscribers.values()) {
      for (const pattern of sub.topics) {
        if (topicMatches(pattern, topic)) {
          send(sub.socket, { t: 'message', topic, payload, retain: !!retain });
          break;
        }
      }
    }
  }

  function publish(topic, payload, { retain = false } = {}) {
    if (retain) retained.set(topic, payload);
    fanOut(topic, payload, retain);
    logger.log(`[broker] publish ${topic} ${retain ? '(retained)' : ''} ->`, JSON.stringify(payload));
  }

  function handleWillFor(sub) {
    if (sub.will) {
      logger.log(`[broker] cliente "${sub.clientId}" caiu sem aviso — publicando LWT em ${sub.will.topic}`);
      publish(sub.will.topic, sub.will.payload, { retain: sub.will.retain });
    }
  }

  function handleConnection(socket) {
    const id = nextId++;
    const sub = { socket, clientId: null, topics: new Set(), will: null, cleanDisconnect: false };
    subscribers.set(id, sub);

    attachFraming(socket, (msg) => {
      if (msg.t === 'connect') {
        sub.clientId = msg.id;
        sub.will = msg.will || null;
        send(socket, { t: 'connack' });
        logger.log(`[broker] "${msg.id}" conectou${msg.will ? ' (com will registrado em ' + msg.will.topic + ')' : ''}`);
      } else if (msg.t === 'subscribe') {
        sub.topics.add(msg.topic);
        send(socket, { t: 'suback', topic: msg.topic });
        // Mensagem retida: entrega imediatamente ao novo assinante, se existir
        for (const [topic, payload] of retained.entries()) {
          if (topicMatches(msg.topic, topic)) {
            send(socket, { t: 'message', topic, payload, retain: true });
          }
        }
      } else if (msg.t === 'publish') {
        publish(msg.topic, msg.payload, { retain: !!msg.retain });
        if (msg.qos === 1 && msg.ref) {
          send(socket, { t: 'puback', ref: msg.ref });
        }
      } else if (msg.t === 'disconnect') {
        sub.cleanDisconnect = true;
        socket.end();
      }
    });

    socket.on('close', () => {
      subscribers.delete(id);
      if (!sub.cleanDisconnect) handleWillFor(sub);
    });
    socket.on('error', () => { /* 'close' também dispara em seguida — trata lá */ });
  }

  function listen(port) {
    const server = net.createServer(handleConnection);
    server.listen(port, () => logger.log(`[broker] mini-broker MQTT-like ouvindo em tcp://localhost:${port}`));
    return server;
  }

  return { listen, publish };
}

module.exports = { createBroker, topicMatches };
