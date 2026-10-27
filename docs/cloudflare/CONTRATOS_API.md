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

## Mapa de operações T02

Comparação estática do contrato OpenAPI com registros Express e dispatch do Worker: **39/39 operações** aparecem nas três fontes; nenhuma operação ou método ficou sem correspondência. Os caminhos abaixo são relativos à base `/api`.

| Caminho | Métodos | OpenAPI | Express | Worker |
| --- | --- | --- | --- | --- |
| `/occupancy/modalities` | GET, POST | Sim | Sim | Sim |
| `/occupancy/modalities/{id}` | PATCH, DELETE | Sim | Sim | Sim |
| `/occupancy` | GET, POST | Sim | Sim | Sim |
| `/occupancy/{id}` | PATCH, DELETE | Sim | Sim | Sim |
| `/occupancy/import/preview` | POST | Sim | Sim | Sim |
| `/occupancy/import` | POST | Sim | Sim | Sim |
| `/occupancy/backup/period` | POST | Sim | Sim | Sim |
| `/occupancy/backup/restore/preview` | POST | Sim | Sim | Sim |
| `/occupancy/backup/restore` | POST | Sim | Sim | Sim |
| `/healthz` | GET | Sim | Sim | Sim |
| `/access-status` | GET | Sim | Sim | Sim |
| `/products` | GET, POST | Sim | Sim | Sim |
| `/products/{id}` | PATCH | Sim | Sim | Sim |
| `/sales` | GET, POST | Sim | Sim | Sim |
| `/sales/import/origins` | GET | Sim | Sim | Sim |
| `/sales/import` | POST | Sim | Sim | Sim |
| `/sales/history` | GET | Sim | Sim | Sim |
| `/sales/scoreboard` | GET | Sim | Sim | Sim |
| `/sales/refund-candidates` | GET | Sim | Sim | Sim |
| `/sales/refunds` | GET | Sim | Sim | Sim |
| `/sales/{id}/refunds` | POST | Sim | Sim | Sim |
| `/sales/refunds/{id}` | PATCH | Sim | Sim | Sim |
| `/sales/refunds/{id}/void` | POST | Sim | Sim | Sim |
| `/sales/refunds/{id}/history` | GET | Sim | Sim | Sim |
| `/sales-goals` | GET, PUT | Sim | Sim | Sim |
| `/sales/backup` | GET | Sim | Sim | Sim |
| `/sales/backup/period` | POST | Sim | Sim | Sim |
| `/sales/restore/preview` | POST | Sim | Sim | Sim |
| `/sales/restore` | POST | Sim | Sim | Sim |
| `/sales/{id}` | PATCH | Sim | Sim | Sim |
| `/sales/{id}/cancel` | POST | Sim | Sim | Sim |
| `/sales/{id}/history` | GET | Sim | Sim | Sim |

**Limite:** a tabela prova presença estática, não igualdade de cálculos, consultas ou persistência. No runtime Worker local foram exercitados health check, assets/SPA e respostas 404; operações que leem ou gravam vendas/ocupação continuam pendentes de D1 isolado nas T04–T08.

O Worker devolve 404 JSON para `/api` e raízes desconhecidas antes de autenticar; dentro de raízes existentes, preserva a autenticação antes de responder a uma rota não reconhecida. Ao acrescentar um recurso de primeiro nível ao OpenAPI, atualize também `API_ROOTS` em `worker/index.ts`.

## Transporte e autorização

- O frontend usa os hooks gerados do OpenAPI e `customFetch` com `credentials: same-origin`; o Bearer é opcional e só é incluído se um getter for configurado.
- O Worker encaminha `/api/*` para as rotas D1 e usa `ASSETS` para a interface com fallback SPA.
- `/api/access-status` valida Clerk e, nas rotas administrativas, preserva o controle `ZERO3_ALLOWED_EMAILS`.
- O Worker ainda consulta o perfil Clerk para obter o e-mail verificado; a validação local da assinatura JWT não torna toda a autorização offline.

## Critério de paridade

Cada operação do OpenAPI precisa ter comportamento equivalente no Express e no Worker, com schema/erros compatíveis e teste executado no runtime destino. A existência do endpoint ou do cliente gerado não prova persistência no Cloudflare.
