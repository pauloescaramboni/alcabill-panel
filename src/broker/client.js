'use strict';

/*
 * Cliente para o mini-broker (ver server.js para o porquê deste arquivo existir
 * em vez de usar o pacote `mqtt` do npm).
 *
 * Interface pública pensada para ficar PARECIDA com a do pacote `mqtt` real
 * (connect/on('message')/subscribe/publish) — trocar a implementação por
 * `require('mqtt').connect(...)` no futuro deve exigir o mínimo de mudança
 * em quem usa este módulo (src/server.js e simulator/etiqueta-sim.js).
 */

const net = require('net');
const EventEmitter = require('events');
const { attachFraming, send } = require('./protocol');

class MiniMqttClient extends EventEmitter {
  constructor({ host = 'localhost', port, clientId, will = null }) {
    super();
    this.host = host;
    this.port = port;
    this.clientId = clientId;
    this.will = will;
    this._pending = new Map(); // ref -> callback, para simular ack de QoS1
    this._refCounter = 1;
    this._connected = false;
    this._subscriptions = [];
    this._connect();
  }

  _connect() {
    this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
      send(this.socket, { t: 'connect', id: this.clientId, will: this.will });
    });

    attachFraming(this.socket, (msg) => {
      if (msg.t === 'connack') {
        this._connected = true;
        // Snapshot ANTES de emitir 'connect': o handler de quem usa este cliente
        // costuma chamar .subscribe(...) de dentro do próprio 'connect' (é o padrão
        // usado em src/server.js e no simulador). Como .subscribe() já envia a
        // mensagem na hora quando _connected=true, se reenviássemos a partir de
        // this._subscriptions DEPOIS do emit (que já contém o que acabou de ser
        // adicionado) cada tópico saía duplicado — e um "subscribe" duplicado faz
        // o broker reenviar a mensagem retida duplicada (foi o que os testes
        // pegaram: o simulador aplicava o mesmo comando duas vezes). Este
        // snapshot serve só para reconexões de verdade (tópicos assinados ANTES
        // desta conexão) — quem assina pela primeira vez dentro do 'connect' não
        // é afetado, pois nada existia em _subscriptions ainda.
        const paraReassinar = this._subscriptions.slice();
        this.emit('connect');
        for (const topic of paraReassinar) send(this.socket, { t: 'subscribe', topic });
      } else if (msg.t === 'message') {
        this.emit('message', msg.topic, msg.payload, { retain: !!msg.retain });
      } else if (msg.t === 'puback') {
        const cb = this._pending.get(msg.ref);
        if (cb) { this._pending.delete(msg.ref); cb(); }
      }
    });

    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => { this._connected = false; this.emit('close'); });
  }

  subscribe(topic) {
    this._subscriptions.push(topic);
    if (this._connected) send(this.socket, { t: 'subscribe', topic });
  }

  publish(topic, payload, opts = {}, onAck) {
    const msg = { t: 'publish', topic, payload, retain: !!opts.retain, qos: opts.qos || 0 };
    if (opts.qos === 1 && onAck) {
      const ref = String(this._refCounter++);
      msg.ref = ref;
      this._pending.set(ref, onAck);
    }
    send(this.socket, msg);
  }

  disconnect() {
    send(this.socket, { t: 'disconnect' });
    this.socket.end();
  }
}

function connect(opts) {
  return new MiniMqttClient(opts);
}

module.exports = { connect };
