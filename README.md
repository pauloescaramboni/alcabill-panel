# ALCABILL — Painel Web (protótipo de software)

Painel de controle para as etiquetas eletrônicas ALCABILL: cadastro de
produtos, cadastro/edição de etiquetas, histórico de alterações e status
online/offline/bateria em tempo (quase) real.

Este pacote é **só a parte de software** da V1 (Celular → Painel Web →
Backend/API → Banco de Dados → MQTT → Wi-Fi). Ele foi construído **antes**
do hardware (LILYGO T5) chegar, usando um **simulador** que se comporta como
uma etiqueta física de verdade — leia a seção
["Por que existe um simulador, e por que ele NÃO é MQTT de verdade"](#por-que-existe-um-simulador-e-por-que-ele-não-é-mqtt-de-verdade)
antes de seguir para o hardware. É a parte mais importante deste documento.

## Requisitos

- Node.js **18 ou mais recente**.
- Um banco **Postgres** acessível (local ou remoto) e a variável de
  ambiente `DATABASE_URL` apontando pra ele — ex.:
  `postgres://usuario:senha@host:5432/nome_do_banco`.
- Rodar `npm install` uma vez (instala só o driver oficial `pg` — o resto
  do projeto continua sem dependências externas; veja a seção
  ["Por que existe um simulador..."](#por-que-existe-um-simulador-e-por-que-ele-não-é-mqtt-de-verdade)
  pra entender por que o broker MQTT-like é caseiro em vez de usar uma
  lib pronta).

## Como rodar

```bash
# 0) instala o driver do Postgres e aponta pro seu banco
npm install
export DATABASE_URL="postgres://usuario:senha@host:5432/nome_do_banco"

# 1) cria o usuário admin inicial (só precisa rodar uma vez)
npm run seed
#   email: admin@alcabill.local   senha: alcabill123
#   (troque a senha depois de logar — não existe tela de troca de senha
#   nesta V1 de protótipo; por enquanto, edite direto no banco ou rode
#   `node scripts/seed.js voce@empresa.com novaSenha "Seu Nome"` com um
#   e-mail novo para criar outro usuário admin)

# 2) sobe o painel (HTTP na porta 8080) + o mini-broker (TCP na porta 1883)
npm start

# 3) num segundo terminal: simula uma etiqueta física conversando via MQTT
npm run simulador -- --id=ALC-000001
```

Acesse **http://localhost:8080**, logue com as credenciais do passo 1.

Ao criar uma etiqueta pelo painel ("+ Nova etiqueta"), o próprio painel
mostra o ID gerado (ex.: `ALC-000002`) e o comando pronto para colar no
terminal do simulador.

### Simulando várias etiquetas ao mesmo tempo

```bash
npm run simulador -- --ids=ALC-000001,ALC-000002,ALC-000003
```

### Simulando uma queda de energia/Wi-Fi (para ver o LWT funcionando)

```bash
npm run simulador -- --id=ALC-000001 --cair-apos=20
```

Depois de 20s o simulador derruba a conexão TCP sem avisar — o mini-broker
detecta isso e publica automaticamente `{state:"offline"}` no lugar da
etiqueta (esse é o "Last Will and Testament" do MQTT). O cartão da etiqueta
deve virar "offline" no painel dentro de poucos segundos (o painel atualiza
sozinho a cada 3s).

Todas as flags do simulador: `--id=`, `--ids=`, `--intervalo=<ms>` (período
da telemetria), `--cair-apos=<segundos>`, `--porta=`, `--host=`.

## O que já funciona (testado ponta a ponta)

- Login/logout com sessão via cookie (`scrypt` para hash de senha).
- Cadastro de produtos e de etiquetas (com numeração serial automática
  `ALC-000001`, `ALC-000002`, ...).
- Edição de quantidade/localização/status de uma etiqueta, com **histórico**
  de cada alteração (campo, valor antigo, valor novo, usuário, quando).
- Publicação automática de um "comando" (retido, QoS1) toda vez que algo
  muda — e reenvio manual via botão "Reenviar atualização".
- Fluxo de confirmação em três fases (a mesma ideia da auditoria técnica):
  1. **enviado** — o backend grava a atualização em `atualizacoes` com
     status `enviado` e publica no tópico de comando.
  2. **recebido (pelo broker)** — o callback de QoS1 do broker confirma que
     a mensagem foi aceita pelo transporte (log `confirmado como entregue
     ao broker`). Isso é o equivalente ao PUBACK do MQTT — confirma que o
     *broker* recebeu, não que a etiqueta aplicou.
  3. **aplicado (pela etiqueta)** — só quando a etiqueta (real ou simulada)
     termina de redesenhar o e-paper, ela publica uma confirmação própria
     no tópico `.../confirmacao`, e **só aí** o backend marca a atualização
     como `confirmado` e atualiza `ultima_atualizacao_aplicada`.
- Detecção de online/offline via LWT (Last Will and Testament) + mensagens
  de status retidas.
- Telemetria periódica de bateria e RSSI.
- Idempotência por versão: reenviar uma atualização já aplicada **não**
  redesenha o e-paper de novo (só reconfirma) — isso importa porque
  displays e-paper têm um número de ciclos de atualização limitado, então
  redesenhar sem necessidade é um desperdício real, não só de software.
- Filtro "mostrar só offline" e painel responsivo (mobile-first).

## Por que existe um simulador, e por que ele NÃO é MQTT de verdade

**Isto é uma correção importante em relação ao que foi dito antes** ("é só
trocar o script simulado pela T5 de verdade sem mexer no resto") — na
prática não é bem assim, e é melhor deixar isso claro agora do que você
descobrir isso na hora de programar o firmware.

O ambiente de desenvolvimento (sandbox) onde este código foi escrito
**bloqueia, por política de rede da conta/organização, o acesso a
`registry.npmjs.org` (npm) e a `archive.ubuntu.com` (apt)**. Isso significa
que não foi possível instalar nenhuma biblioteca de terceiros — nem o
pacote `mqtt`, nem `aedes` (broker MQTT em JS), nem instalar um Mosquitto
via apt. Toda tentativa retornou erro `403 host_not_allowed` do proxy da
própria infraestrutura, e não é algo contornável (nem deveria ser).

A saída foi implementar, usando **só módulos nativos do Node** (`net`,
`node:crypto`, `node:http`), um **mini-broker próprio**
(`src/broker/server.js`, ~120 linhas) e um **cliente próprio**
(`src/broker/client.js`) que reproduzem o *contrato* que a auditoria
técnica definiu para o MQTT:

- tópicos no formato `alcabill/{empresa}/etiquetas/{id}/{comando|status|confirmacao|telemetria}`
- mensagens retidas (retain)
- confirmação de entrega estilo QoS1 (um PUBACK simplificado)
- Last Will and Testament (LWT)

O que ele **não é**: o protocolo binário MQTT 3.1.1/5.0 de verdade. Ele
fala "um JSON por linha" sobre um socket TCP puro. Um firmware real rodando
uma biblioteca MQTT de verdade (`PubSubClient` ou `esp-mqtt`, no mundo
ESP32/Arduino) **não vai conseguir conversar com este mini-broker** — os
bytes que trafegam na rede são diferentes, não é só uma questão de mudar o
endereço IP.

### Caminho de migração para MQTT de verdade

Quando este projeto rodar num ambiente com acesso normal à internet (sua
máquina, um servidor, um CI sem essa restrição):

1. `npm install mqtt aedes` — ou, melhor ainda para produção, suba um
   broker separado de verdade (Mosquitto ou EMQX) em vez de embutir o
   broker no processo do backend.
2. Troque **só o arquivo `src/broker/client.js`** por um wrapper fino sobre
   o pacote `mqtt` (`mqtt.connect(...)`), mantendo a mesma interface
   pública que ele já tem hoje (`connect`, `.subscribe(topic)`,
   `.publish(topic, payload, opts, callback)`, evento `'message'`). Foi por
   isso que essa interface foi desenhada parecida com a do pacote `mqtt`
   real — a ideia sempre foi facilitar essa troca. **Nada em `src/server.js`
   nem no simulador precisa mudar**, os dois só usam essa interface.
3. Troque `src/broker/server.js` por `require('aedes')()` +
   `net.createServer(aedes.handle)`, ou simplesmente aponte o backend (e o
   firmware) para o endereço de um Mosquitto/EMQX já rodando — nesse caso
   `src/broker/server.js` deixa de ser necessário.
4. O **firmware real do LILYGO T5** vai usar uma biblioteca MQTT de verdade
   (ex.: `PubSubClient`) apontando para esse mesmo broker, publicando e
   assinando **exatamente os mesmos tópicos** já definidos em
   `src/topics.js` e o **mesmo formato de payload JSON** já usado aqui. O
   fluxo de confirmação em 3 fases não muda nada — só a camada de
   transporte MQTT passa a ser de verdade.

O que **não muda** nessa migração: o schema do banco, a API REST inteira,
a lógica de negócio (histórico, versionamento, reenvio), o frontend e a
estrutura de tópicos. Só a "cor do cano" (transporte MQTT) muda — o
conteúdo que passa por dentro dele é o mesmo que já está implementado e
testado aqui.

## Sobre a migração para Postgres — o que foi e o que não foi testado aqui

Mesma lógica de transparência da seção anterior, agora sobre o banco de
dados: o painel **começou** rodando em SQLite (arquivo local, zero
dependências) e foi **migrado para Postgres** depois, especificamente para
poder ser hospedado no Render — o disco de um serviço web gratuito lá é
**efêmero** (é apagado a cada novo deploy/reinício), então um arquivo
SQLite não sobreviveria.

O mesmo bloqueio de rede do sandbox que impediu instalar `mqtt`/`aedes`
(veja acima) também bloqueou `npm install pg` — então o driver Postgres
**não pôde ser instalado nem testado de verdade neste ambiente**. O que
foi possível validar aqui, com um Postgres 16 real instalado localmente:

- O schema inteiro (`CREATE TABLE ...`) rodado e confirmado válido em
  Postgres de verdade, inclusive o `IF NOT EXISTS` sendo idempotente
  (rodar duas vezes não dá erro).
- Cada formato de consulta usado no código (INSERT com `RETURNING *`,
  UPDATE com coluna dinâmica, o JOIN de etiquetas+produtos, o `COUNT(*)`)
  testado manualmente via `psql` com valores reais.
- Uma pegadinha real encontrada e corrigida por causa desse teste: o
  Postgres devolve `COUNT(*)` como `bigint`, e o driver `pg` traz isso
  como **texto** em JavaScript (pra não perder precisão) — sem tratar
  isso, o gerador de código serial (`ALC-000001`, `ALC-000002`, ...)
  ia concatenar strings (`"5" + 1 = "51"`) em vez de somar. Corrigido em
  `proximoSerial()` (`src/server.js`) com `Number(row.n) + 1`.
- Todo ponto do código que faz uma consulta ao banco foi auditado (via
  busca automatizada, não só revisão visual) para confirmar que tem
  `await` na frente — a troca de SQLite (síncrono) pra Postgres
  (assíncrono) é exatamente o tipo de mudança onde um `await` esquecido
  não dá erro de sintaxe, só devolve dado errado silenciosamente em
  produção.
- `node --check` em todos os arquivos alterados (sintaxe válida) e uma
  tentativa real de `node src/server.js` contra esse Postgres local, só
  pra confirmar que a única coisa que falta é mesmo o pacote `pg` (erro
  `Cannot find module 'pg'` — nenhum outro erro antes disso).

O que **não** foi possível testar aqui, e só vai ser verificado depois do
deploy no Render (que tem acesso normal à internet pra instalar o `pg` de
verdade): o comportamento real do driver conversando com um Postgres pela
rede — pool de conexões, SSL, timeouts. O plano é fazer um teste de ponta
a ponta contra a URL pública assim que o deploy subir (login, criar
produto/etiqueta, editar, ver histórico) e corrigir na hora se algo
aparecer — não deixar isso pra você descobrir sozinho depois.

## Limitações conhecidas desta V1 de software (esperadas num protótipo)

- **Sessões em memória**: reiniciar o processo do backend desloga todo
  mundo. Numa versão comercial isso vira um store compartilhado (Redis,
  por exemplo) ou JWT — a própria auditoria já lista isso como pendência
  da V1 → comercial.
- **Sem HTTPS**: rode atrás de um proxy reverso (nginx/Caddy) com TLS em
  qualquer ambiente que não seja `localhost`.
- **Sessões somem se o processo reiniciar** também vale a pena repetir
  aqui: como o Postgres agora é um serviço separado (não mais um arquivo
  junto do código), reiniciar o painel não apaga mais os dados — só as
  sessões de login em memória, que é a limitação já citada acima.
- **Sem paginação**: `/api/etiquetas` devolve tudo de uma vez. Ótimo para
  um protótipo com dezenas de etiquetas, ruim para milhares — resolver
  quando chegar lá.
- **Atualização do painel por polling (3s), não WebSocket/push**: mais
  simples de implementar e depurar num protótipo; funciona bem para a
  escala de um piloto. Migrar para WebSocket (ou Server-Sent Events) é uma
  melhoria futura razoável, não uma correção urgente.
- **Broker embutido no processo do backend**: fácil de rodar num
  protótipo (um `npm start` só), mas não é como isso deveria ficar em
  produção — nesse ponto, um broker separado (item 3 da migração acima)
  já resolve isso e escala melhor.

## Estrutura do projeto

```
alcabill-panel/
├── package.json
├── scripts/
│   └── seed.js              # cria o usuário admin inicial
├── simulator/
│   └── etiqueta-sim.js      # simula uma ou mais etiquetas físicas
├── src/
│   ├── server.js            # HTTP + API REST + regras de negócio
│   ├── db.js                 # schema + acesso ao Postgres (via `pg`)
│   ├── auth.js                # hash de senha (scrypt) + sessões
│   ├── topics.js              # definição dos tópicos MQTT (contrato)
│   └── broker/
│       ├── server.js          # mini-broker MQTT-like (ver seção acima)
│       ├── client.js          # cliente do mini-broker (troca por `mqtt` real)
│       └── protocol.js        # framing "JSON por linha" sobre TCP
├── public/                    # frontend (HTML/CSS/JS puro, sem build)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── data/                       # criado em tempo de execução (estado dos simuladores) — não versionar
```

## Próximos passos sugeridos

1. Validar este painel com você (fluxo de cadastro/edição/histórico) antes
   de investir tempo no firmware.
2. Quando o LILYGO T5 chegar: montar o protótipo físico (T5 + bateria +
   caixa) em paralelo, sem depender do painel — são frentes independentes.
3. Escrever o firmware do T5 falando MQTT de verdade, num ambiente com
   internet liberada, seguindo o caminho de migração descrito acima.
4. Só depois, plugar o T5 real no mesmo broker que o firmware usa e
   aposentar o simulador (ele já terá cumprido o papel dele).
