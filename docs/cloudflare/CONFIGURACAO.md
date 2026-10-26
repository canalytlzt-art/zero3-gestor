# Configuração Cloudflare

Este arquivo registra nomes e localização das configurações, nunca seus valores secretos.

## Build do frontend

Arquivo de build: `artifacts/zero3-pro-vendas/vite.config.ts`; script principal em `artifacts/zero3-pro-vendas/package.json`.

- `PORT`: obrigatório pelo Vite; build Cloudflare atual usa `5173`.
- `BASE_PATH`: obrigatório pelo Vite; Worker principal usa `/`.
- `VITE_CLERK_PUBLISHABLE_KEY`: chave pública da mesma instância Clerk usada pelo Worker.
- `VITE_CLERK_PROXY_URL`: URL de proxy Clerk do ambiente escolhido; usada no build de homologação.

As duas variáveis `VITE_*` são incorporadas ao frontend durante o build e não são Secrets de Runtime.

## Runtime do Worker

Bindings tipados em `artifacts/zero3-pro-vendas/src/worker/types.ts`; configuração de recursos em `wrangler.jsonc`.

- `DB`: binding D1. Produção aponta para `zero3-pro-gestao-db`.
- `ASSETS`: Static Assets de `./dist/public`.
- `CLERK_SECRET_KEY`: Secret do Worker; usado para consultar o usuário/e-mail verificado no Clerk.
- `CLERK_JWT_KEY`: PEM público da mesma instância Clerk; configure no Runtime, não no repositório.
- `CLERK_ISSUER`: emissor HTTPS exato dessa instância.
- `CLERK_AUTHORIZED_PARTIES`: origens HTTPS autorizadas, separadas por vírgula.
- `ZERO3_ALLOWED_EMAILS`: e-mails administrativos permitidos, separados por vírgula; preserve a allowlist vigente.

Não registrar valores, tokens, cookies, chaves ou conteúdo de `.env` em documentação, logs ou Git.

## Homologação

`wrangler.test.jsonc` define o nome `zero3-gestor-teste` e o nome lógico `zero3-pro-gestao-db-teste`, mas atualmente carrega o mesmo `database_id` da configuração principal. Tratar como **inseguro para deploy** até que um D1 de teste seja criado e seu ID correto seja configurado. O nome do recurso não isola um binding quando o ID referencia outro banco.

## Ambiente Replit

O servidor Express e Drizzle exigem `DATABASE_URL` (PostgreSQL); `CLERK_PUBLISHABLE_KEY` e `CLERK_SECRET_KEY` são lidas pelo middleware Clerk do processo Node. Essas variáveis são para o backend Express e não substituem o binding D1 nem os bindings Clerk do Worker.
