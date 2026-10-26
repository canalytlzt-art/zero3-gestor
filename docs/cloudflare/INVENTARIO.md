# Inventário ZERO3 PRO Gestão

Auditoria T01 do repositório em 2026-10-26. O inventário identifica código e testes; não comprova execução integrada no Cloudflare.

## Arquitetura observada

- Monorepo pnpm 10.26.1 com nove entradas no `pnpm -r list --depth -1`: workspace raiz e oito pacotes nomeados (`api-server`, `mockup-sandbox`, `zero3-pro-vendas`, `api-client-react`, `api-spec`, `api-zod`, `db` e `scripts`).
- Interface React/Vite em `artifacts/zero3-pro-vendas`; saída configurada em `dist/public`.
- Contrato OpenAPI em `lib/api-spec/openapi.yaml`; cliente React e schemas gerados em `lib/api-client-react/` e `lib/api-zod/`.
- Há duas implementações executáveis da API: Express em `artifacts/api-server/` com PostgreSQL/Drizzle (`DATABASE_URL`) e Cloudflare Worker em `artifacts/zero3-pro-vendas/src/worker/` com D1 (`DB`). Ambas expõem os mesmos grupos funcionais; paridade e persistência remota ainda precisam de validação.
- `wrangler.jsonc` define o Worker principal `zero3-gestor`, Static Assets e D1. `wrangler.test.jsonc` define `zero3-gestor-teste`, mas seu `database_id` é igual ao da configuração principal. **Bloqueio: não publicar a configuração de teste até ela apontar para um D1 separado confirmado.**
- O produto identificado neste artefato é o gestor de vendas/ocupação. Não foram encontrados arquivos de leaderboard, baterias ou modo TV no app inspecionado; manter esse produto fora do escopo.

## Funções e dependências

| Função | Interface | API/contrato | Persistência | Testes encontrados e lacuna |
| --- | --- | --- | --- | --- |
| Login e autorização administrativa | `src/App.tsx` | `GET /api/access-status`; Express `routes/sales.ts`; Worker `auth.ts` e `index.ts` | Clerk; allowlist `ZERO3_ALLOWED_EMAILS` no Runtime | `worker/auth.test.ts` cobre JWT/rota local; login real e configuração Cloudflare não foram verificados nesta auditoria. |
| Produtos e modalidades | `components/sales-management.tsx`, `components/occupancy-management.tsx` | `/api/products`, `/api/occupancy/modalities` | D1 `products`, `occupancy_modalities`; PostgreSQL equivalente em `lib/db/src/schema/` | Integração Express em testes de vendas/ocupação; não há teste de rota de negócio do Worker na lista do pacote. |
| Vendas, histórico, edição e cancelamento | `components/sales-management.tsx` | `/api/sales`, `/api/sales/history`, `/api/sales/{id}`, `/api/sales/{id}/cancel`, histórico por venda | D1 `sales`, `sales_history`, `idempotency_keys` | `sales.integration.test.ts` e testes de domínio/importação; Worker sales sem teste de integração no script atual. |
| Scoreboard financeira e metas | `App.tsx`, `components/scoreboard-goals.tsx`, `components/occupancy-charts-page.tsx` | `/api/sales/scoreboard`, `/api/sales-goals` | D1 `sales`, `sales_refunds`, `sales_goals`, `products` | `sales-utils.test.ts`, `financial-chart-data.test.ts` e cenários Express; alguns testes unitários não estão no comando `test` do app. |
| Estornos e histórico | `components/sales-management.tsx` | `/api/sales/refund-candidates`, `/api/sales/refunds`, `/api/sales/{id}/refunds`, edição/anulação/histórico | D1 `sales_refunds`, `sales_history`, `idempotency_keys` | Cenários em `sales.integration.test.ts`; rotas Cloudflare não testadas de ponta a ponta. |
| Importação/exportação financeira e backup | `components/sales-management.tsx`, `src/lib/sales-import.ts`, `sales-workbook.ts`, `sales-export.ts` | `/api/sales/import`, origens, backups, prévia/restauração | D1 `sales`, `sales_import_batches`, histórico, metas, estornos e produtos | Testes de importação/workbook/backup existem; o script `test` do app não inclui `sales-import.test.ts`. |
| Lançamentos de ocupação | `components/occupancy-management.tsx` | `/api/occupancy`, `/api/occupancy/modalities`, PATCH/DELETE | D1 `occupancy_records`, `occupancy_modalities`, `occupancy_history`, ligação opcional a `products` | `occupancy.integration.test.ts` existe, mas não é chamado pelo script `test:integration` atual; Worker sem teste de integração. |
| Importação de ocupação | `components/occupancy-import-dialog.tsx` | `/api/occupancy/import/preview`, `/api/occupancy/import` | D1 `occupancy_records`, hashes/origens e histórico | `occupancy-import.test.ts` e testes Express; o teste unitário não está no script `test` atual do app. |
| Gráficos, filtros e relatórios de ocupação | `components/occupancy-charts-page.tsx`, `occupancy-reports-dialog.tsx` | `/api/occupancy` e produtos/modalidades de apoio | D1 `occupancy_records`, `products`, `occupancy_modalities` | Há testes de agregação, filtros e planilha; não estão todos no comando padrão de testes. |
| Backup/restauração de ocupação | `components/occupancy-import-dialog.tsx`, `occupancy-reports-dialog.tsx` | `/api/occupancy/backup/period`, prévia e restauração | D1 registros, modalidades e histórico | `occupancy-backup.integration.test.ts` existe, mas não está no comando `test:integration` atual. |

## Dados e implantação

- Migrações D1 rastreadas: `scripts/d1/migrations/0001_zero3_schema.sql` e `0002_sales_import_origin_unique.sql`.
- Há snapshot de desenvolvimento local com manifesto datado de 2026-10-23 e `totalRows: 1360`. Nesta auditoria foram lidos apenas metadados agregados; as linhas não foram abertas.
- `scripts/d1/import_snapshot_to_d1.py` é explicitamente local: adiciona `--local`, `--persist-to` isolado, compara conflitos, importa idempotentemente e concilia contagens/totais. Isso não comprova migração remota.
- Arquivos do snapshot/SQLite estão sob `.local/`, ignorados pelo Git e não devem ser adicionados.
- Vite requer `PORT` e `BASE_PATH`; build Cloudflare define ambos e gera `dist/public`. A publicação Wrangler usa o Worker como primeira rota para `/api/*` e fallback SPA.

## Riscos e pendências da auditoria

1. Separar o D1 de teste do D1 principal antes de qualquer deploy de homologação.
2. Confirmar bindings/Secrets e origem Clerk no Runtime Cloudflare; um dry-run não verifica sua correspondência.
3. Validar rotas de vendas e ocupação executando o Worker com D1 de homologação, não apenas o Express/PostgreSQL.
4. Ampliar os comandos de teste para incluir testes já existentes e contratos executados no Worker.
5. Revalidar a cópia D1 local com persistência explícita; não inferir estado do D1 remoto.
