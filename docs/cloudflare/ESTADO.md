# Estado Cloudflare

Atualizado em 2026-10-26.

## Etapa atual

- T01 — auditoria do repositório e plano: **concluída**.
- T02 — build, paridade estática e runtime Worker local: **concluída no workspace**; não é validação integrada em Cloudflare.
- T03 — Clerk e autorização: **concluída em código/testes locais**; autenticação real no domínio Cloudflare permanece pendente.
- Análise/fontes e mensagens por etapa fornecidas pelo proprietário incorporadas como requisitos de execução, não como comprovação de que o código já os cumpre.
- Próxima etapa: T04 — D1 isolado, aguardando escolha do proprietário e configuração de um banco de teste separado.

## Arquivos de T01 e T02

- `replit.md`
- `docs/cloudflare/INVENTARIO.md`
- `docs/cloudflare/PLANO.md`
- `docs/cloudflare/ESTADO.md`
- `docs/cloudflare/CONFIGURACAO.md`
- `docs/cloudflare/CONTRATOS_API.md`
- `docs/cloudflare/CONCILIACAO.md`
- `docs/cloudflare/TESTES.md`
- `docs/cloudflare/ACEITE.md`
- `docs/cloudflare/OPERACAO.md`
- Requisitos extraídos de `ANALISE_E_FONTES.md` registrados no inventário, plano, conciliação e matriz de testes.
- Código T02: `artifacts/zero3-pro-vendas/src/worker/index.ts`, `src/worker/auth.test.ts`, `wrangler.jsonc`; `artifacts/api-server/src/app.ts`; `lib/api-client-react/tsconfig.json`.
- Código T03: `artifacts/zero3-pro-vendas/src/lib/access-validation-error.ts`, `src/lib/access-validation-error.test.ts`, `src/App.tsx`, `src/worker/auth.test.ts`, `package.json`; `artifacts/api-server/package.json` e `pnpm-lock.yaml` atualizados dentro das faixas já declaradas.

## Inspeção e comandos

- Inventariados manifests, workspaces, telas, API Express, Worker, OpenAPI, schemas, migrações D1 e scripts de snapshot/importação.
- `pnpm -r list --depth -1`: workspace raiz mais 8 pacotes.
- `jq` no manifesto privado local (somente metadados agregados): origem de desenvolvimento explícita, data 2026-10-23, 1.360 linhas totais.
- Revisados os scripts de build/teste e a configuração Wrangler principal e de teste.
- Comparação de métodos/caminhos OpenAPI × Express × Worker: 39/39 correspondências estáticas; tabela em `CONTRATOS_API.md`.
- Não foram lidas linhas do snapshot; não foram consultados bancos remotos.

## Validações

- Testes do app: 36 aprovados; `pnpm run typecheck`: aprovado após separar testes Node da biblioteca de navegador.
- Build Vite com `PORT=5173 BASE_PATH=/ NODE_ENV=production`: aprovado; gerou `dist/public` (2.584 módulos; avisos não bloqueantes de sourcemap e chunk).
- Wrangler 4.152.0 dry-run: aprovado, leu 8 assets e não publicou.
- Wrangler local com `--local` e `--persist-to /tmp/zero3-t02-worker`: `/` e `/scoreboard` 200 HTML; `/api/healthz` 200 JSON; `/api` e `/api/no-such-api` 404 JSON.
- Express pelo proxy local: rota `/api` desconhecida respondeu 404 JSON. Os 39 endpoints foram comparados estaticamente, não executados individualmente.
- Nenhum deploy, migração, consulta ao D1 remoto ou alteração de dados foi realizado.
- Checklist `CHECKLIST_ACEITE.md` registrado em `docs/cloudflare/ACEITE.md`; o compartilhamento do D1 entre configs de teste e principal continua reprovado.
- T03: 44 testes aprovados; typecheck, build Vite e Wrangler dry-run aprovados após atualizar versões de patch Clerk. O build teve apenas avisos de sourcemap e tamanho de chunk.
- Os workflows web/API reiniciaram; o API-server compilou e iniciou. A captura local mostrou a landing e a tela Clerk de entrada com Google/e-mail. Nenhum login foi realizado.
- O teste unitário do proxy confirmou repasse de cookies e resposta `Set-Cookie`; não é prova de renovação real de sessão ou conexão do Worker publicado.

## Pendências que bloqueiam homologação

- `wrangler.test.jsonc` referencia o mesmo D1 ID da configuração principal; requer D1 de teste realmente isolado.
- Configuração Runtime Clerk/D1 ainda precisa ser confirmada no ambiente alvo.
- `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_KEY` e `CLERK_ISSUER` não foram comparadas por valor; devem corresponder à mesma instância Clerk Development.
- As rotas de negócio do Worker precisam de testes de integração em D1 de homologação.
- Os scripts atuais não executam todos os testes de importação/ocupação já existentes.

## Próximo passo

Solicitar escolha do proprietário antes de T04; não executar deploy de teste enquanto `wrangler.test.jsonc` apontar para o D1 principal.
