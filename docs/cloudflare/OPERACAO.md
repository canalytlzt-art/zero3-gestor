# Operação Cloudflare

## Desenvolvimento e validação local

- Interface Replit: `pnpm --filter @workspace/zero3-pro-vendas run dev`.
- API Express/Replit: `pnpm --filter @workspace/api-server run dev`.
- Verificações gerais: `pnpm run typecheck` e `pnpm run build`.
- Testes locais do app: `pnpm --filter @workspace/zero3-pro-vendas run test`.
- Validação Wrangler sem publicação: `pnpm --filter @workspace/scripts exec wrangler deploy --dry-run --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..`.
- Migração/importação D1 local: seguir `scripts/d1/README.md`; usar somente `--local` e o `--persist-to` explícito.
- Provisionamento D1 remoto de teste: autenticar Wrangler pelo fluxo OAuth com `pnpm --filter @workspace/scripts exec wrangler login` no Replit Shell. Não colar tokens no chat. Não usar o deploy de teste enquanto `wrangler.test.jsonc` ainda apontar para o D1 principal.

## Publicação

- Worker principal: `zero3-gestor`, configuração `artifacts/zero3-pro-vendas/wrangler.jsonc`.
- Comando cadastrado para publicar (não executar sem autorização): `pnpm --filter @workspace/zero3-pro-vendas run deploy:cloudflare`.
- Homologação: `zero3-gestor-teste`; **não publicar até corrigir o ID D1 compartilhado** em `wrangler.test.jsonc`.
- Build e `dry-run` não configuram Secrets, não validam acesso real ao banco e não substituem testes integrados.

## Segurança e recuperação

- Manter Clerk no Worker com JWT validado, emissor/origem corretos e `ZERO3_ALLOWED_EMAILS`; nunca contornar autenticação para diagnosticar.
- Não colocar chaves em arquivos públicos, variáveis Vite, logs ou commits. Configurar Secrets no Runtime e variáveis públicas somente na etapa de build apropriada.
- Não alterar ou restaurar dados financeiros/ocupação em produção sem autorização específica e cópia recuperável.
- Em qualquer incidente de migração, interromper novas escritas, preservar o banco e seguir plano de recuperação validado; não apagar/recriar D1.
- Registrar em `ESTADO.md` comandos, resultados, arquivos, pendências e próximo passo.
