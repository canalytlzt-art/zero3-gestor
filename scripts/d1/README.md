# Zero3 PRO: migração e cópia para D1 local

Este diretório contém a primeira migração D1, a configuração isolada do Wrangler e as ferramentas de importação e conciliação da cópia verificada do banco de desenvolvimento. Não altera a aplicação Replit, não se conecta ao PostgreSQL nem à conta Cloudflare remota.

## Executar contra Wrangler D1 local

```sh
pnpm --filter @workspace/scripts d1:import-local
pnpm --filter @workspace/scripts d1:test-sqlite
```

O importador exige o manifesto e os dez arquivos da cópia em `.local/cloudflare-prep/zero3-dev-2026-10-23/`. Ele verifica os hashes e o manifesto antes de executar `wrangler d1 migrations apply` e `wrangler d1 execute`, sempre com `--local`, configuração própria e persistência isolada. Não oferece caminho para executar o SQL remotamente.

```text
.local/cloudflare-prep/zero3-dev-2026-10-23/wrangler-state/
```

Esse caminho está coberto por `.local/` no `.gitignore` e guarda o banco D1 local com dados privados. Antes de inserir, o script compara todos os registros existentes com a cópia; conflitos interrompem a carga sem sobrescrever registros. Os `INSERT` usam `ON CONFLICT(id) DO NOTHING`, e uma segunda leitura confere todos os campos, contagens e totais.

Os IDs UUID permanecem como texto; datas de negócio como `YYYY-MM-DD`; timestamps como texto ISO 8601; valores monetários em centavos como inteiros; percentuais de ocupação como texto decimal para preservar a representação original. Históricos e campos JSON são mantidos como JSON válido.

O teste SQLite independente verifica reimportação, conflitos, integridade referencial e rollback da carga quando uma inserção falha. A transferência principal é feita pelo D1 local do Wrangler, não por essa base auxiliar.

## Limite desta etapa

A validação executa migração e importação contra D1 local do Wrangler. Não cria banco remoto na conta Cloudflare, não publica Workers e não altera o PostgreSQL oficial ou a aplicação atual.
