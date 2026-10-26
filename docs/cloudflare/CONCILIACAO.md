# Conciliação de dados

## Evidência local disponível

Há snapshot de desenvolvimento em `.local/cloudflare-prep/zero3-dev-2026-10-23/`, ignorado pelo Git. O manifesto indica origem PostgreSQL `development (explicit database query)`, geração 2026-10-23 e **1.360 linhas** agregadas:

| Tabela | Linhas |
| --- | ---: |
| `idempotency_keys` | 5 |
| `occupancy_history` | 616 |
| `occupancy_modalities` | 2 |
| `occupancy_records` | 573 |
| `products` | 1 |
| `sales` | 80 |
| `sales_goals` | 0 |
| `sales_history` | 82 |
| `sales_import_batches` | 1 |
| `sales_refunds` | 0 |
| **Total** | **1.360** |

Nesta auditoria foram consultados apenas a origem, data e contagens do manifesto; os registros individuais e valores financeiros não foram lidos.

## Ferramentas e limites

- `scripts/d1/import_snapshot.py` valida manifesto, hash, arquivos/tabelas e métricas.
- `scripts/d1/import_snapshot_to_d1.py` usa Wrangler `--local` e `--persist-to` explícito, faz preflight de conflitos, `ON CONFLICT(id) DO NOTHING` e reconcilia todos os campos e totais.
- `scripts/d1/test_import_snapshot.py` testa repetição, conflitos, integridade e rollback.
- `scripts/d1/README.md` declara que o processo não acessa PostgreSQL nem conta Cloudflare remota.

## O que ainda não está comprovado

- A presença do manifesto e do estado SQLite local não prova que o banco local atual foi revalidado nesta auditoria.
- Não foi verificada migração do D1 remoto, nem equivalência do banco principal.
- Não executar importação remota, limpar dados ou reconstruir o D1 principal como correção de autenticação.

## Próxima conciliação

Na T04, revalidar a cópia local usando exatamente `--local` e `--persist-to` do importador; executar o teste de reimportação e comparar contagens, campos e totais do manifesto. Só depois planejar a homologação com D1 separado. Não copiar os arquivos privados para Git.

Na T05/T06, conciliar também as regras da origem: linhas financeiras importáveis sem produto, datas de venda resolvidas sem preencher com hoje, estornos pela data efetiva confirmada no contrato atual e ocupação medida separada de percentuais legados. Não alterar dados para fazer totais coincidirem sem identificar a causa.
