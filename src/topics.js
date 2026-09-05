'use strict';

// Estrutura de tópicos definida na auditoria técnica (seção 5):
//   alcabill/{empresa_id}/etiquetas/{etiqueta_id}/comando       — backend->etiqueta, retained, QoS1
//   alcabill/{empresa_id}/etiquetas/{etiqueta_id}/status        — etiqueta->backend, LWT + retained, QoS1
//   alcabill/{empresa_id}/etiquetas/{etiqueta_id}/confirmacao   — etiqueta->backend, QoS1
//   alcabill/{empresa_id}/etiquetas/{etiqueta_id}/telemetria    — bateria/RSSI/uptime, QoS0
//
// Nesta V1 (protótipo de software) a "empresa" é fixa — um único inquilino.

const EMPRESA = 'alcabill';

function comando(etiquetaId) {
  return `alcabill/${EMPRESA}/etiquetas/${etiquetaId}/comando`;
}
function status(etiquetaId) {
  return `alcabill/${EMPRESA}/etiquetas/${etiquetaId}/status`;
}
function confirmacao(etiquetaId) {
  return `alcabill/${EMPRESA}/etiquetas/${etiquetaId}/confirmacao`;
}
function telemetria(etiquetaId) {
  return `alcabill/${EMPRESA}/etiquetas/${etiquetaId}/telemetria`;
}

// Padrões com wildcard (o backend assina esses para ouvir TODAS as etiquetas)
const WILD = {
  status: `alcabill/${EMPRESA}/etiquetas/+/status`,
  confirmacao: `alcabill/${EMPRESA}/etiquetas/+/confirmacao`,
  telemetria: `alcabill/${EMPRESA}/etiquetas/+/telemetria`,
};

// Extrai o {etiqueta_id} de um tópico concreto, dado o índice do segmento (posição 3, começando em 0)
function etiquetaIdFromTopic(topic) {
  const partes = topic.split('/');
  return partes[3];
}

module.exports = { EMPRESA, comando, status, confirmacao, telemetria, WILD, etiquetaIdFromTopic };
