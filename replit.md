# ZERO3 PRO Gestão

Aplicativo administrativo para vendas, Scoreboard financeira, ocupação das aulas, importações, relatórios e backups.

## Run & Operate

- `pnpm --filter @workspace/zero3-pro-vendas run dev` — interface Vite.
- `pnpm --filter @workspace/api-server run dev` — API Express usada no ambiente Replit.
- `pnpm run typecheck` — verifica os workspaces.
- `pnpm run build` — typecheck e builds recursivos.
- `pnpm --filter @workspace/zero3-pro-vendas run test` — testes selecionados da interface e Worker.
- `pnpm --filter @workspace/api-spec run codegen` — regenera cliente e schemas a partir de `lib/api-spec/openapi.yaml`.
- O build Vite exige `PORT` e `BASE_PATH`; a saída usada pelo Worker é `artifacts/zero3-pro-vendas/dist/public`.
- O backend Express/PostgreSQL exige `DATABASE_URL`. O Worker Cloudflare usa o binding D1 `DB`; são runtimes distintos.
- Consulte `docs/cloudflare/OPERACAO.md` antes de qualquer dry-run ou publicação.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Persistência Replit: PostgreSQL + Drizzle ORM
- Persistência Cloudflare: Worker + D1, com SQL e migrações próprias
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/zero3-pro-vendas/src/components/` — telas de vendas, Scoreboard, ocupação, gráficos, importação e relatórios.
- `artifacts/zero3-pro-vendas/src/worker/` — API Cloudflare Worker, autenticação e acesso a D1.
- `artifacts/api-server/src/routes/` — implementação Express dos contratos de vendas e ocupação.
- `lib/api-spec/openapi.yaml` — contrato de API; cliente gerado em `lib/api-client-react/`.
- `lib/db/src/schema/` — esquema PostgreSQL; `scripts/d1/migrations/` — esquema/migrações D1.
- `docs/cloudflare/` — inventário, plano, estado, configuração, contratos, conciliação, testes e operação Cloudflare.

## Architecture decisions

- O destino de publicação é Cloudflare Workers + Static Assets + D1; o Express/PostgreSQL permanece como runtime do workspace e precisa manter paridade de contrato até o corte ser validado.
- O frontend usa o cliente gerado e cookies Clerk same-origin; a allowlist administrativa é `ZERO3_ALLOWED_EMAILS`.
- Valores financeiros são persistidos em centavos inteiros; datas de negócio são datas civis e ocupação tem registros diários e mensais.
- Importações e restaurações devem ser idempotentes, auditáveis e conciliadas antes de qualquer alteração de dados.
- Importação financeira precisa aceitar cliente, data de venda e valor; plano/produto é opcional. Usar `Data de início` como data da venda quando presente, senão resolver uma data inequívoca; nunca substituir por hoje.
- Preservar ocupação medida por presenças/capacidade e os percentuais legados sem inventar capacidade nem misturar taxas incompatíveis. Conferir a origem antes de mudar fórmulas.

## Product

O escopo deste gestor inclui vendas, produtos, cancelamentos/estornos, metas, Scoreboard financeira, ocupação, modalidades, importação de planilhas, gráficos, relatórios e backups/restaurações. Não incorporar funcionalidades de leaderboard esportivo, baterias ou modo TV sem comprovar que pertencem a este produto.

## User preferences

- Preservar registros, IDs, vínculos, cálculos, filtros e comportamento existentes durante a adaptação.
- Não alterar banco ou publicar em produção sem autorização específica.

## Gotchas

- `wrangler.test.jsonc` ainda referencia o mesmo `database_id` da configuração principal; não fazer deploy de teste até substituí-lo pelo ID real do D1 isolado.
- O snapshot local em `.local/cloudflare-prep/` e arquivos SQLite são privados; nunca adicioná-los ao Git.
- O importador `scripts/d1/import_snapshot_to_d1.py` é local-only e deve continuar usando `--local` e seu `--persist-to` explícito.
- A configuração de Runtime do Worker, as variáveis de build `VITE_*` e o processo Express são camadas separadas.
- A lista de testes npm atual não executa todos os testes existentes de ocupação/importação nem testa as rotas de negócio do Worker.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Leia `docs/cloudflare/ESTADO.md` ao retomar trabalho Cloudflare.
- Siga as etapas de `docs/cloudflare/PLANO.md`; valide interface, API, persistência e testes para cada função.
- Nunca trate build, preview do Replit ou dry-run como prova de publicação integrada.
