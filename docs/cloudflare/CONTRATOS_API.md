# Contratos de API

## Fonte do contrato

- Especificação: `lib/api-spec/openapi.yaml`, base `/api`.
- Geração: `lib/api-spec/orval.config.ts`.
- Cliente e schemas consumidos pela interface: `lib/api-client-react/src/generated/` e pacote `lib/api-zod/`.
- Implementação Express: `artifacts/api-server/src/routes/sales.ts` e `occupancy.ts`.
- Implementação Cloudflare: `artifacts/zero3-pro-vendas/src/worker/index.ts`, `sales.ts` e `occupancy.ts`.

## Grupos de operação

- Saúde e acesso: `GET /healthz`, `GET /access-status`.
- Produtos: `/products`, incluindo criação e atualização.
- Vendas: `/sales`, histórico, edição, cancelamento e histórico por lançamento.
- Scoreboard/metas: `/sales/scoreboard`, `/sales-goals`.
- Estornos: candidatos, listagem, criação, edição, anulação e histórico.
- Importação financeira: inspeção de origens e importação de planilha.
- Backup financeiro: backup mensal/período, prévia e restauração.
- Ocupação: registros, modalidades, importação/prévia e backup/prévia/restauração.

## Transporte e autorização

- O frontend usa os hooks gerados do OpenAPI e `customFetch` com `credentials: same-origin`; o Bearer é opcional e só é incluído se um getter for configurado.
- O Worker encaminha `/api/*` para as rotas D1 e usa `ASSETS` para a interface com fallback SPA.
- `/api/access-status` valida Clerk e, nas rotas administrativas, preserva o controle `ZERO3_ALLOWED_EMAILS`.
- O Worker ainda consulta o perfil Clerk para obter o e-mail verificado; a validação local da assinatura JWT não torna toda a autorização offline.

## Critério de paridade

Cada operação do OpenAPI precisa ter comportamento equivalente no Express e no Worker, com schema/erros compatíveis e teste executado no runtime destino. A existência do endpoint ou do cliente gerado não prova persistência no Cloudflare.
