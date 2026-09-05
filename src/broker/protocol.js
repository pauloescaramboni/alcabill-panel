'use strict';

// Framing simples "JSON por linha" sobre um socket TCP: cada mensagem é um
// objeto JSON seguido de "\n". Isso é tudo que o mini-broker precisa —
// não é o protocolo binário do MQTT (ver README, seção "Por que não é MQTT de verdade").

function attachFraming(socket, onMessage) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    // eslint-disable-next-line no-cond-assign
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        continue; // linha corrompida — ignora (um cliente real de produção logaria isso)
      }
      onMessage(msg);
    }
  });
}

function send(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch (err) {
    // socket já fechado — ignora silenciosamente, quem chama trata reconexão
  }
}

module.exports = { attachFraming, send };
