'use strict';

const telaLogin = document.getElementById('tela-login');
const app = document.getElementById('app');
const listaEl = document.getElementById('lista-etiquetas');
const modalRaiz = document.getElementById('modal-raiz');

let produtosCache = [];
let etiquetasCache = [];
let somenteOffline = false;

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    method: opcoes.method || 'GET',
    headers: opcoes.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    credentials: 'same-origin',
  });
  if (resp.status === 401) { mostrarLogin(); throw new Error('não autenticado'); }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || `erro ${resp.status}`);
  return dados;
}

function mostrarLogin() {
  telaLogin.classList.remove('oculto');
  app.classList.add('oculto');
}
function mostrarApp() {
  telaLogin.classList.add('oculto');
  app.classList.remove('oculto');
}

// Nome no topo + botão "Usuários" só aparece pra quem é admin (só admin
// pode criar acesso pra mais gente — ver rota /api/usuarios no server).
function aplicarUsuarioLogado(user) {
  document.getElementById('usuario-nome').textContent = user.nome;
  document.getElementById('btn-usuarios').classList.toggle('oculto', user.papel !== 'admin');
}

// ---------- login ----------
document.getElementById('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = document.getElementById('login-email').value;
  const senha = document.getElementById('login-senha').value;
  const erroEl = document.getElementById('login-erro');
  erroEl.classList.add('oculto');
  try {
    const user = await api('/api/login', { method: 'POST', body: { email, senha } });
    aplicarUsuarioLogado(user);
    mostrarApp();
    await carregarTudo();
    iniciarPolling();
  } catch (err) {
    erroEl.textContent = 'E-mail ou senha inválidos.';
    erroEl.classList.remove('oculto');
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  mostrarLogin();
});

document.getElementById('btn-trocar-senha').addEventListener('click', () => {
  abrirModal(`
    <h3>Trocar senha</h3>
    <label>Senha atual</label><input id="ts-atual" type="password" autocomplete="current-password" />
    <label>Nova senha</label><input id="ts-nova" type="password" autocomplete="new-password" />
    <label>Confirmar nova senha</label><input id="ts-confirmar" type="password" autocomplete="new-password" />
    <div class="erro oculto" id="ts-erro"></div>
    <div class="linha-botoes">
      <button class="botao" id="ts-salvar">Salvar</button>
      <button class="botao secundario" data-fechar>Cancelar</button>
    </div>`);
  document.getElementById('ts-salvar').addEventListener('click', async () => {
    const senha_atual = document.getElementById('ts-atual').value;
    const senha_nova = document.getElementById('ts-nova').value;
    const confirmar = document.getElementById('ts-confirmar').value;
    const erroEl = document.getElementById('ts-erro');
    erroEl.classList.add('oculto');
    if (senha_nova !== confirmar) {
      erroEl.textContent = 'As senhas novas não coincidem.';
      erroEl.classList.remove('oculto');
      return;
    }
    try {
      await api('/api/senha', { method: 'PUT', body: { senha_atual, senha_nova } });
      fecharModal();
      alert('Senha alterada com sucesso.');
    } catch (err) {
      erroEl.textContent = err.message;
      erroEl.classList.remove('oculto');
    }
  });
});

// ---------- usuários (só admin vê o botão — ver aplicarUsuarioLogado) ----------
document.getElementById('btn-usuarios').addEventListener('click', async () => {
  try {
    const usuarios = await api('/api/usuarios');
    renderizarModalUsuarios(usuarios);
  } catch (err) {
    alert(err.message);
  }
});

function renderizarModalUsuarios(usuarios) {
  const linhas = usuarios.map((u) => `<li><b>${u.nome}</b> — ${u.email} <span class="meta">(${u.papel})</span></li>`).join('');
  abrirModal(`
    <h3>Usuários com acesso</h3>
    <ul class="historico-lista">${linhas}</ul>
    <h3 style="margin-top:18px">Adicionar usuário</h3>
    <label>Nome</label><input id="nu-nome" />
    <label>E-mail</label><input id="nu-email" type="email" />
    <label>Senha</label><input id="nu-senha" type="password" autocomplete="new-password" />
    <div class="erro oculto" id="nu-erro"></div>
    <div class="linha-botoes">
      <button class="botao" id="nu-salvar">Criar acesso</button>
      <button class="botao secundario" data-fechar>Fechar</button>
    </div>`);
  document.getElementById('nu-salvar').addEventListener('click', async () => {
    const nome = document.getElementById('nu-nome').value.trim();
    const email = document.getElementById('nu-email').value.trim();
    const senha = document.getElementById('nu-senha').value;
    const erroEl = document.getElementById('nu-erro');
    erroEl.classList.add('oculto');
    try {
      await api('/api/usuarios', { method: 'POST', body: { nome, email, senha } });
      const atualizados = await api('/api/usuarios');
      renderizarModalUsuarios(atualizados);
    } catch (err) {
      erroEl.textContent = err.message;
      erroEl.classList.remove('oculto');
    }
  });
}

// ---------- carregamento ----------
async function carregarTudo() {
  const [produtos, etiquetas] = await Promise.all([api('/api/produtos'), api('/api/etiquetas')]);
  produtosCache = produtos;
  etiquetasCache = etiquetas;
  renderizarLista();
}

function tempoRelativo(iso) {
  if (!iso) return 'nunca';
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  return `há ${h}h`;
}

function renderizarLista() {
  const itens = somenteOffline ? etiquetasCache.filter((e) => !e.online) : etiquetasCache;
  if (itens.length === 0) {
    const msg = somenteOffline && etiquetasCache.length > 0
      ? 'Nenhuma etiqueta offline no momento.'
      : 'Nenhuma etiqueta cadastrada ainda.';
    listaEl.innerHTML = `<div class="vazio">${msg}</div>`;
    return;
  }
  listaEl.innerHTML = itens.map(cartaoHtml).join('');
  itens.forEach((e) => {
    document.getElementById(`cartao-${e.id}`).querySelector('.linha-topo-cartao').addEventListener('click', () => alternarEdicao(e.id));
  });
}

function cartaoHtml(e) {
  const bateria = e.bateria_v != null ? `${e.bateria_v.toFixed(2)} V` : '—';
  const produto = e.produto_descricao || '(sem produto vinculado)';
  return `
  <div class="cartao-etiqueta" id="cartao-${e.id}">
    <div class="linha-topo-cartao">
      <div>
        <div class="serial">${e.id}</div>
        <div class="produto-nome">${produto}</div>
        <div class="meta"><span class="status-dot ${e.online ? 'on' : 'off'}"></span>${e.online ? 'online' : 'offline'} · última comunicação ${tempoRelativo(e.ultima_comunicacao)}</div>
      </div>
      <span class="badge">${e.status}</span>
    </div>
    <div class="grade-info">
      <div>Localização<b>${e.localizacao || '—'}</b></div>
      <div>Bateria<b>${bateria}</b></div>
      <div>Versão<b>v${e.version}</b></div>
    </div>
    <div class="painel-edicao oculto" id="edicao-${e.id}"></div>
  </div>`;
}

function alternarEdicao(id) {
  const painel = document.getElementById(`edicao-${id}`);
  const aberto = !painel.classList.contains('oculto');
  document.querySelectorAll('.painel-edicao').forEach((p) => p.classList.add('oculto'));
  if (aberto) return;
  const e = etiquetasCache.find((x) => x.id === id);
  painel.innerHTML = `
    <label>Localização</label>
    <input type="text" id="loc-${id}" value="${e.localizacao || ''}" />
    <label>Status</label>
    <select id="sts-${id}">
      ${['ativo', 'manutenção', 'inativo'].map((s) => `<option value="${s}" ${s === e.status ? 'selected' : ''}>${s}</option>`).join('')}
    </select>
    <div class="linha-botoes">
      <button class="botao pequeno" data-acao="salvar">Salvar</button>
      <button class="botao pequeno secundario" data-acao="reenviar">Reenviar atualização</button>
      <button class="botao pequeno secundario" data-acao="historico">Ver histórico</button>
    </div>
  `;
  painel.classList.remove('oculto');
  painel.querySelector('[data-acao="salvar"]').addEventListener('click', () => salvarEdicao(id));
  painel.querySelector('[data-acao="reenviar"]').addEventListener('click', () => reenviar(id));
  painel.querySelector('[data-acao="historico"]').addEventListener('click', () => abrirHistorico(id));
}

async function salvarEdicao(id) {
  const localizacao = document.getElementById(`loc-${id}`).value;
  const status = document.getElementById(`sts-${id}`).value;
  await api(`/api/etiquetas/${id}`, { method: 'PUT', body: { localizacao, status } });
  await carregarTudo();
}

async function reenviar(id) {
  await api(`/api/etiquetas/${id}/reenviar`, { method: 'POST' });
  alert('Atualização reenviada — o comando foi publicado novamente (retained) para essa etiqueta.');
}

async function abrirHistorico(id) {
  const hist = await api(`/api/etiquetas/${id}/historico`);
  const linhas = hist.length
    ? hist.map((h) => `<li><b>${h.campo}</b>: ${h.valor_antigo ?? '—'} → ${h.valor_novo} <span class="meta">(${h.usuario}, ${tempoRelativo(h.criado_em)})</span></li>`).join('')
    : '<li class="meta">Sem alterações registradas ainda.</li>';
  abrirModal(`<h3>Histórico — ${id}</h3><ul class="historico-lista">${linhas}</ul><button class="botao" data-fechar>Fechar</button>`);
}

// ---------- modais: novo produto / nova etiqueta ----------
function abrirModal(innerHtml) {
  modalRaiz.innerHTML = `<div class="modal-fundo"><div class="modal">${innerHtml}</div></div>`;
  modalRaiz.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', fecharModal));
  modalRaiz.querySelector('.modal-fundo').addEventListener('click', (ev) => { if (ev.target.classList.contains('modal-fundo')) fecharModal(); });
}
function fecharModal() { modalRaiz.innerHTML = ''; }

document.getElementById('btn-novo-produto').addEventListener('click', () => {
  abrirModal(`
    <h3>Novo produto</h3>
    <label>Código</label><input id="np-codigo" />
    <label>Descrição</label><input id="np-descricao" />
    <div class="linha-botoes">
      <button class="botao" id="np-salvar">Salvar</button>
      <button class="botao secundario" data-fechar>Cancelar</button>
    </div>`);
  document.getElementById('np-salvar').addEventListener('click', async () => {
    const codigo = document.getElementById('np-codigo').value.trim();
    const descricao = document.getElementById('np-descricao').value.trim();
    if (!codigo || !descricao) return;
    await api('/api/produtos', { method: 'POST', body: { codigo, descricao } });
    fecharModal();
    await carregarTudo();
  });
});

document.getElementById('btn-nova-etiqueta').addEventListener('click', () => {
  const opcoesProduto = produtosCache.map((p) => `<option value="${p.id}">${p.codigo} — ${p.descricao}</option>`).join('');
  abrirModal(`
    <h3>Nova etiqueta</h3>
    <div id="ne-bloco-produto-existente">
      <label>Produto</label>
      <select id="ne-produto">${opcoesProduto || '<option value="">(nenhum produto cadastrado ainda)</option>'}</select>
      <button type="button" class="botao pequeno secundario" id="ne-ir-novo-produto" style="margin-top:6px">+ cadastrar novo produto</button>
    </div>
    <div id="ne-bloco-produto-novo" class="oculto">
      <label>Código do produto</label>
      <input id="ne-novo-codigo" placeholder="ex.: CAM-001" />
      <label>Descrição do produto</label>
      <input id="ne-novo-descricao" placeholder="ex.: Camiseta azul M" />
      <button type="button" class="botao pequeno secundario" id="ne-ir-produto-existente" style="margin-top:6px">← usar produto já cadastrado</button>
    </div>
    <label>Localização</label><input id="ne-localizacao" placeholder="ex.: A-03-02" />
    <div class="erro oculto" id="ne-erro"></div>
    <div class="linha-botoes">
      <button class="botao" id="ne-salvar">Criar</button>
      <button class="botao secundario" data-fechar>Cancelar</button>
    </div>`);

  // Atalho pra não obrigar a cadastrar o produto num passo separado antes —
  // alterna entre "escolher produto existente" e "digitar um produto novo"
  // dentro do próprio modal de criar etiqueta.
  const blocoExistente = document.getElementById('ne-bloco-produto-existente');
  const blocoNovo = document.getElementById('ne-bloco-produto-novo');
  document.getElementById('ne-ir-novo-produto').addEventListener('click', () => {
    blocoExistente.classList.add('oculto');
    blocoNovo.classList.remove('oculto');
  });
  document.getElementById('ne-ir-produto-existente').addEventListener('click', () => {
    blocoNovo.classList.add('oculto');
    blocoExistente.classList.remove('oculto');
  });

  document.getElementById('ne-salvar').addEventListener('click', async () => {
    const erroEl = document.getElementById('ne-erro');
    erroEl.classList.add('oculto');
    const localizacao = document.getElementById('ne-localizacao').value.trim();
    try {
      let produto_id;
      if (!blocoNovo.classList.contains('oculto')) {
        const codigo = document.getElementById('ne-novo-codigo').value.trim();
        const descricao = document.getElementById('ne-novo-descricao').value.trim();
        if (!codigo || !descricao) {
          erroEl.textContent = 'Preencha código e descrição do novo produto.';
          erroEl.classList.remove('oculto');
          return;
        }
        const novoProduto = await api('/api/produtos', { method: 'POST', body: { codigo, descricao } });
        produto_id = novoProduto.id;
      } else {
        produto_id = Number(document.getElementById('ne-produto').value) || null;
      }
      const nova = await api('/api/etiquetas', { method: 'POST', body: { produto_id, localizacao } });
      fecharModal();
      await carregarTudo();
      alert(`Etiqueta ${nova.id} criada. Rode o simulador apontando para esse ID para vê-la responder:\n\nnpm run simulador -- --id=${nova.id}`);
    } catch (err) {
      erroEl.textContent = err.message;
      erroEl.classList.remove('oculto');
    }
  });
});

document.getElementById('chk-offline').addEventListener('change', (ev) => {
  somenteOffline = ev.target.checked;
  renderizarLista();
});

// ---------- polling leve (sem WebSocket — ver README) ----------
function iniciarPolling() {
  setInterval(() => { carregarTudo().catch(() => {}); }, 3000);
}

// tenta restaurar sessão existente ao abrir a página
api('/api/me').then((user) => {
  aplicarUsuarioLogado(user);
  mostrarApp();
  carregarTudo();
  iniciarPolling();
}).catch(() => mostrarLogin());
