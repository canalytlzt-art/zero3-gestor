# Plano por etapas Cloudflare

Plano da auditoria T01, baseado nos arquivos atuais. Cada etapa deve ter alteração pequena, validação própria e commit revisável. Não publicar em produção, alterar o D1 principal ou executar restauração destrutiva sem autorização específica.

O estado de cada critério de aceite, incluindo ambiente e limites da evidência, fica em [`ACEITE.md`](./ACEITE.md). Não converter “Aprovado local” em aprovação de homologação.

## T02 — Build reproduzível e API no runtime Workers

- **Estado:** concluída no workspace local; build, typecheck, testes, dry-run, smoke do Worker e mapa estático executados. Não inclui validação Cloudflare remota.
- Conferir `artifacts/zero3-pro-vendas/vite.config.ts`, scripts de `package.json`, `wrangler.jsonc`, `worker/index.ts` e dependências usadas no Worker.
- Garantir build com pnpm 10.26.1, `PORT`, `BASE_PATH`, assets em `dist/public`, fallback SPA e rotas `/api/*` no Worker.
- Comparar endpoints `lib/api-spec/openapi.yaml`, Express `artifacts/api-server/src/routes/` e Worker `src/worker/`.
- Garantir resposta JSON 404 para `/api` e uma rota API desconhecida.
- Testar o Worker no runtime local compatível e registrar build, rotas e comportamento observado. Não publicar em produção nesta etapa.
- Critério: build reprodutível, dry-run Wrangler válido e mapa de paridade das rotas; sem publicar.

## T03 — Clerk e autorização

- Verificar a sessão same-origin, proxy Clerk, JWT local, emissor, origem autorizada e `ZERO3_ALLOWED_EMAILS`.
- Usar a mesma instância Clerk Development no build e Runtime. Não imprimir nem gravar credenciais.
- Testar acesso autorizado e não autorizado, renovação e falhas de sessão; quando faltar configuração, indicar o nome do campo e a tela do Cloudflare sem pedir o segredo no chat.
- Critério: teste de Worker para sessão válida, ausente, expirada, inválida e não autorizada; validação real só quando o Runtime correto estiver configurado.

## T04 — D1, migrações e conciliação

- **Pré-requisito:** obter/configurar um D1 de homologação independente; substituir o ID compartilhado em `wrangler.test.jsonc` antes de deploy.
- Revalidar migrações e snapshot local com `--local` e `--persist-to` explícito. Planejar qualquer mudança estrutural com cópia, migração versionada, reexecução idempotente, conciliação e recuperação.
- Confirmar o banco/manifesto existente e conciliar contagens, IDs, vínculos e totais; repetir a importação em ambiente isolado para provar idempotência.
- Não consultar, migrar, recriar ou alterar o D1 principal nesta etapa sem autorização.

## T05 — Vendas, importação e Scoreboard

- Cobrir cadastro/edição de vendas e produtos, cliente, filtros, cancelamentos, estornos, metas, histórico, importações, exportações e backup/restauração.
- Comparar resultados do Worker/D1 com contratos, testes e regras financeiras existentes; conciliar quantidades, centavos, datas e estados.
- Na importação, validar todas as abas/linhas com dados; cliente, data e valor são obrigatórios e produto é opcional. Priorizar `Data de início` como data de venda; não usar a data atual como fallback.
- Conferir a data efetiva considerada para estornos em cada relatório e preservar o comportamento vigente.

## T06 — Ocupação

- Cobrir modalidades e vínculos, registros diários/mensais, exclusão auditável, importação, filtros, consolidações e gráficos.
- Preservar a compatibilidade das planilhas de importação e os registros legados apenas percentuais.
- Confirmar as origens e fórmulas atuais antes de alterar cálculos: não somar percentuais, inventar capacidade nem substituir silenciosamente taxa ponderada por média simples.
- Manter os gráficos de Ocupação separados dos de Faturamento e os filtros de relatórios/backups independentes dos filtros do dashboard.

## T07 — Relatórios e backups

- Validar escopo de datas, totais, abas, filtros, limites de paginação e restauração para vendas e ocupação.
- Confirmar idempotência, prévia/conflitos, preservação de IDs e plano de recuperação sem alterar produção.

## T08 — Integração, publicação e recuperação

- Executar a matriz de testes no runtime Workers com D1 isolado, teste de autenticação real autorizado e conciliação ponta a ponta.
- Documentar configuração, publicação, operação, observabilidade e recuperação.
- Entregar evidências e pendências; só publicar produção após autorização explícita.

## Bloqueio conhecido

`artifacts/zero3-pro-vendas/wrangler.test.jsonc` atualmente usa o mesmo `database_id` da configuração principal. Não executar `deploy:cloudflare:test` até criar/configurar um D1 realmente separado e confirmar o ID. Não substituir essa referência por um UUID inventado.

## Protocolo para tentativas repetidas

Se uma correção falhar repetidamente, interromper mudanças especulativas, ler `ESTADO.md`, reproduzir o erro atual e identificar sua causa antes de editar. Preservar validações aprovadas e limitar a correção aos arquivos necessários; não reiniciar toda a migração.
