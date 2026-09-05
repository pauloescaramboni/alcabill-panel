'use strict';

/*
 * SIMULADOR DE ETIQUETA — faz o papel de uma LILYGO T5 física enquanto o
 * hardware não chega. Fala exatamente o mesmo "protocolo" (via
 * src/broker/client.js) que o firmware real vai falar quando existir — ver
 * README.md, seção "Do simulador para o hardware real", para o que muda e
 * o que não muda nessa transição.
 *
 * Uso:
 *   npm run simulador -- --id=ALC-000001
 *   npm run simulador -- --ids=ALC-000001,ALC-000002,ALC-000003
 *   npm run simulador -- --id=ALC-000001 --intervalo=5000
 *   npm run simulador -- --id=ALC-000001 --cair-apos=25
 *
 * Flags:
 *   --id=<ID>           uma etiqueta simulada (padrão: ALC-000001)
 *   --ids=<ID,ID,...>   várias etiquetas simuladas no mesmo processo
 *   --intervalo=<ms>    período da telemetria (padrão: 8000ms; num T5 real
 *                       isso seria um ciclo de "acordar, publicar, dormir",
 *                       bem mais espaçado para economizar bateria)
 *   --cair-apos=<s>     depois de N segundos, derruba a conexão TCP sem
 *                       aviso (sem enviar disconnect limpo) — serve para
 *                       demonstrar o Last Will and Testament (a etiqueta
 *                       deve aparecer "offline" no painel)
 *   --porta=<porta>     porta do mini-broker (padrão: BROKER_PORT ou 1883)
 *   --host=<host>       host do mini-broker (padrão: localhost)
 *
 * Importante: este simulador NÃO lê o banco de dados nem conhece a
 * existência do backend além do broker — de propósito. Um T5 de verdade
 * também não teria acesso ao SQLite do servidor; ele só sabe o próprio ID
 * (gravado na fábrica/config) e fala com o broker. Por isso a forma de
 * simular várias etiquetas é passar vários IDs por fora (--ids=...), não
 * perguntar ao banco quais etiquetas existem.
 */

const path = require('node:path');
const fs = require('node:fs');
const topics = require('../src/topics');
const brokerClient = require('../src/broker/client');

// ---------- linha de comando ----------
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const HOST = args.host || 'localhost';
const PORT = args.porta ? Number(args.porta) : (process.env.BROKER_PORT ? Number(process.env.BROKER_PORT) : 1883);
const INTERVALO_TELEMETRIA = args.intervalo ? Number(args.intervalo) : 8000;
const CAIR_APOS_MS = args['cair-apos'] ? Number(args['cair-apos']) * 1000 : null;

let ids = [];
if (args.ids) ids = String(args.ids).split(',').map((s) => s.trim()).filter(Boolean);
else if (args.id) ids = [String(args.id)];
else {
  ids = ['ALC-000001'];
  console.log('Nenhum --id informado — simulando a etiqueta padrão ALC-000001.');
  console.log('Dica: ao criar uma etiqueta no painel, ele mostra o ID exato e o comando pronto para colar aqui.');
}

// ---------- estado persistido por etiqueta simulada (equivalente à NVS de um ESP32 real) ----------
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function arquivoEstado(id) {
  return path.join(DATA_DIR, `sim-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function carregarEstado(id) {
  try {
    return JSON.parse(fs.readFileSync(arquivoEstado(id), 'utf8'));
  } catch (err) {
    return { ultimaVersaoAplicada: null, ultimoUpdateId: null, bateria_v: 4.2 };
  }
}

function salvarEstado(id, estado) {
  fs.writeFileSync(arquivoEstado(id), JSON.stringify(estado, null, 2));
}

// ---------- uma etiqueta simulada ----------
function iniciarEtiqueta(id) {
  const estado = carregarEstado(id);
  const prefixo = `[sim:${id}]`;
  let cliente = null;
  let pararReconexao = false;

  function conectar() {
    cliente = brokerClient.connect({
      host: HOST,
      port: PORT,
      clientId: id,
      will: {
        topic: topics.status(id),
        payload: { state: 'offline', timestamp: new Date().toISOString() },
        retain: true,
      },
    });

    cliente.on('connect', () => {
      console.log(`${prefixo} conectado ao broker (${HOST}:${PORT})`);
      cliente.subscribe(topics.comando(id));
      cliente.publish(
        topics.status(id),
        { state: 'online', timestamp: new Date().toISOString() },
        { retain: true, qos: 1 },
        () => console.log(`${prefixo} status "online" publicado (retido)`)
      );
    });

    cliente.on('message', (topic, payload) => {
      if (topic === topics.comando(id)) aoReceberComando(payload);
    });

    // Sem este listener, um erro de conexão (ex.: servidor ainda não subiu)
    // derrubaria o processo inteiro — EventEmitter sem listener de 'error' lança.
    cliente.on('error', (err) => {
      console.log(`${prefixo} não foi possível conectar (${err.code || err.message}) — tentando de novo em 2s...`);
    });

    cliente.on('close', () => {
      if (pararReconexao) return;
      setTimeout(conectar, 2000);
    });
  }

  function aoReceberComando(payload) {
    const repeticaoExata = payload.update_id && payload.update_id === estado.ultimoUpdateId;
    const versaoJaAplicada = estado.ultimaVersaoAplicada != null && payload.version <= estado.ultimaVersaoAplicada;

    if (repeticaoExata) {
      console.log(`${prefixo} comando repetido (update ${payload.update_id}) — já aplicado, reconfirmando sem redesenhar o e-paper`);
      return confirmar(payload);
    }
    if (versaoJaAplicada) {
      console.log(`${prefixo} v${payload.version} já é a versão atual (aplicada: v${estado.ultimaVersaoAplicada}) — reconfirmando sem redesenhar (poupa ciclos de refresh do e-paper)`);
      return confirmar(payload);
    }

    console.log(`${prefixo} novo comando: v${payload.version} — ${payload.codigo || '(sem produto)'} | qtd=${payload.quantidade} | local=${payload.localizacao || '—'} | status=${payload.status}`);
    console.log(`${prefixo} atualizando e-paper... (um refresh completo real leva ~1-2s, não é instantâneo)`);
    setTimeout(() => {
      estado.ultimaVersaoAplicada = payload.version;
      estado.ultimoUpdateId = payload.update_id;
      salvarEstado(id, estado);
      console.log(`${prefixo} e-paper atualizado para v${payload.version}`);
      confirmar(payload);
    }, 1200 + Math.round(Math.random() * 400));
  }

  function confirmar(payload) {
    cliente.publish(
      topics.confirmacao(id),
      { update_id: payload.update_id, version: payload.version, status: 'applied', timestamp: new Date().toISOString() },
      { qos: 1 },
      () => console.log(`${prefixo} confirmação enviada (update ${payload.update_id}, v${payload.version})`)
    );
  }

  function publicarTelemetria() {
    if (!cliente) return;
    estado.bateria_v = Math.max(3.3, Number((estado.bateria_v - 0.01 * Math.random()).toFixed(3)));
    salvarEstado(id, estado);
    const rssi = -40 - Math.round(Math.random() * 45); // -40 (ótimo) a -85 dBm (fraco)
    cliente.publish(topics.telemetria(id), { bateria_v: estado.bateria_v, rssi, timestamp: new Date().toISOString() }, { qos: 0 });
    console.log(`${prefixo} telemetria: bateria=${estado.bateria_v.toFixed(2)}V rssi=${rssi}dBm`);
  }

  conectar();
  const timerTelemetria = setInterval(publicarTelemetria, INTERVALO_TELEMETRIA);

  if (CAIR_APOS_MS) {
    setTimeout(() => {
      console.log(`${prefixo} 🔌 simulando queda abrupta de energia/Wi-Fi — o broker deve publicar o "will" (offline) por esta etiqueta`);
      pararReconexao = true; // sem isso, o simulador reconectaria em 2s e estragaria a demonstração do LWT
      clearInterval(timerTelemetria);
      if (cliente && cliente.socket) cliente.socket.destroy(); // fecha o TCP sem {t:'disconnect'} -> broker entende como queda
    }, CAIR_APOS_MS);
  }

  return {
    desconectarLimpo() {
      pararReconexao = true;
      clearInterval(timerTelemetria);
      if (cliente) cliente.disconnect();
    },
  };
}

console.log(`Simulador ALCABILL — ${ids.length} etiqueta(s): ${ids.join(', ')}`);
console.log(`Conectando em tcp://${HOST}:${PORT} (mini-broker do painel — precisa do "npm start" rodando)`);
const etiquetasSimuladas = ids.map(iniciarEtiqueta);

process.on('SIGINT', () => {
  console.log('\nEncerrando simulador (desconexão limpa, sem disparar o will)...');
  etiquetasSimuladas.forEach((e) => e.desconectarLimpo());
  setTimeout(() => process.exit(0), 300);
});
