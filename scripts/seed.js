'use strict';

// Cria o usuário administrador inicial, se ainda não existir.
// Uso: npm run seed  (ou: node scripts/seed.js seu@email.com suaSenha "Seu Nome")

const db = require('../src/db');
const { hashPassword } = require('../src/auth');

const email = process.argv[2] || 'admin@alcabill.local';
const senha = process.argv[3] || 'alcabill123';
const nome = process.argv[4] || 'Administrador';

async function main() {
  // Chamado aqui também (não só em src/server.js) porque este script pode
  // ser o primeiro a rodar contra um banco Postgres novinho, sem tabelas ainda.
  await db.inicializarEsquema();

  const existente = await db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (existente) {
    console.log(`Usuário ${email} já existe (id ${existente.id}) — nada a fazer.`);
    return;
  }

  const { hash, salt } = hashPassword(senha);
  await db.prepare(
    'INSERT INTO usuarios (nome, email, senha_hash, salt, papel, criado_em) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(nome, email, hash, salt, 'admin', new Date().toISOString());

  console.log('Usuário criado com sucesso:');
  console.log(`  email: ${email}`);
  console.log(`  senha: ${senha}`);
  console.log('Troque essa senha depois de logar — este script é só para o primeiro acesso.');
}

main()
  .catch((err) => {
    console.error('[seed] erro:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
