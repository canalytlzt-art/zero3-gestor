# Operação Cloudflare

Comandos abaixo partem da raiz do monorepo e usam pnpm 10.26.1. Nenhum comando de publicação ou alteração de D1 foi executado nesta validação.

## Instalação e validação local

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/zero3-pro-vendas run test
pnpm --filter @workspace/zero3-pro-vendas run test:workers
pnpm --filter @workspace/api-server run test:integration
pnpm --filter @workspace/api-server exec tsx --test src/routes/occupancy.integration.test.ts src/routes/occupancy-backup.integration.test.ts
PORT=5173 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/zero3-pro-vendas run build
pnpm --filter @workspace/scripts exec wrangler deploy --dry-run --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..
```

- Desenvolvimento da interface Replit: `pnpm --filter @workspace/zero3-pro-vendas run dev`.
- API Express/Replit: `pnpm --filter @workspace/api-server run dev`.
- Os testes `test:workers` rodam em Workerd/Miniflare com D1 efêmero e `remoteBindings: false`; não carregam `wrangler.test.jsonc`.
- Para D1 local persistente, siga `scripts/d1/README.md`, usando `--local` e um diretório `--persist-to` exclusivo. Não remova snapshots nem SQLite como parte de testes.

## Variáveis: build versus Worker Runtime

**Somente no ambiente de build do frontend:** `PORT`, `BASE_PATH`, `NODE_ENV`, `VITE_CLERK_PUBLISHABLE_KEY` e `VITE_CLERK_PROXY_URL`. As variáveis `VITE_*` entram no JavaScript público; use somente a chave publicável e URL do mesmo ambiente Clerk. Nunca passe `CLERK_SECRET_KEY` ao Vite.

**No Worker Runtime:** binding `DB` apontando para o D1 do ambiente; `ASSETS`; variáveis `CLERK_JWT_KEY`, `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES` e `ZERO3_ALLOWED_EMAILS`; Secret `CLERK_SECRET_KEY`. Configure no Cloudflare Worker Settings, sem gravar valores no Git, logs ou arquivos `VITE_*`. Preserve a allowlist existente.

Para cadastrar a Secret pelo Wrangler, depois de autenticar a conta correta:

```sh
pnpm --filter @workspace/scripts exec wrangler secret put CLERK_SECRET_KEY --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..
```

O comando solicita o valor no terminal. Não o inclua em argumentos, chat, documentação ou histórico do shell. Os outros nomes de variáveis devem ser definidos no Runtime do Worker correspondente; confirme que todas as chaves Clerk pertencem à mesma instância antes de liberar acesso.

## Estado e comandos de publicação

- Principal: Worker `zero3-gestor`, configuração `artifacts/zero3-pro-vendas/wrangler.jsonc`, D1 configurado no repositório como `zero3-pro-gestao-db`.
- Homologação: Worker `zero3-gestor-teste`; **bloqueada** porque `wrangler.test.jsonc` ainda contém o mesmo `database_id` da configuração principal. Não executar `deploy:cloudflare:test` nem seu dry-run enquanto esse ID não for substituído por um D1 de teste confirmado.
- `wrangler whoami` não autenticou nesta etapa; painel, Secrets, ID real do D1, versão implantada e histórico de deployments não foram reconciliados.
- Dry-run principal já aprovado localmente, mas apenas empacota assets e bindings. Não testa Clerk, rede, escrita/leitura do D1 nem configuração do painel.
- Depois de reconciliação, revisão do commit e aprovação explícita de publicação, o comando do Worker principal é `pnpm --filter @workspace/zero3-pro-vendas run deploy:cloudflare`. **Não foi executado.**
- Para observar logs após autenticação e seleção correta da conta: `pnpm --filter @workspace/scripts exec wrangler tail --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..`. Não filtre nem compartilhe cookies, tokens, e-mails ou chaves.

## Recuperação e critérios de interrupção

Antes de qualquer publicação, registrar o commit exato e o identificador da versão estável ativa em **Workers & Pages → `zero3-gestor` → Deployments**. A versão atualmente publicada não pôde ser consultada nesta etapa.

- Se qualquer administrador autorizado não conseguir entrar, se uma rota necessária retornar erro persistente após uma nova tentativa, se algum total divergir ou se importação/exportação/backups falharem, interromper a liberação e não iniciar a próxima etapa.
- Preservar os bancos e logs sanitizados; não apagar, recriar ou restaurar D1 automaticamente. O responsável pela conta Cloudflare deve decidir sobre pausa de escritas e retorno do Worker à versão estável registrada.
- Rollback do Worker reverte código, não dados nem schema. Recuperação D1 exige uma cópia recuperável e uma restauração exercitada em recurso isolado.
- A disponibilidade/retenção de exportação e Time Travel do D1, a versão estável anterior e o procedimento de recuperação ainda não foram verificados no painel. Não assumir que um recurso está disponível até testá-lo no D1 de homologação.

Registrar cada comando, resultado, commit, ambiente e pendência em `ESTADO.md` e `ACEITE.md`. Produção só pode ser considerada validada depois de publicação autorizada e teste da URL real.
