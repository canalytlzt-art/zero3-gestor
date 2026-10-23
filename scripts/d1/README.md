# Zero3 PRO: cópia SQLite compatível com D1 (somente local)

Este diretório contém a primeira migração do esquema para SQLite/D1, o importador da cópia verificada do banco de desenvolvimento e os testes de conciliação. Não altera a aplicação Replit, não se conecta ao PostgreSQL e não contém os dados da cópia no Git.

## Executar no workspace

```sh
python3 scripts/d1/import_snapshot.py
python3 -m unittest scripts/d1/test_import_snapshot.py
```

O importador exige o manifesto e os dez arquivos da cópia em `.local/cloudflare-prep/zero3-dev-2026-10-23/`. Antes de escrever, confere SHA-256, tamanhos, esquema de cada arquivo, contagens, totais de vendas e métricas de ocupação. O arquivo resultante fica em:

```text
.local/cloudflare-prep/zero3-dev-2026-10-23/d1-local.sqlite
```

Esse caminho está coberto por `.local/` no `.gitignore`. O importador bloqueia outros destinos; não aceita URL ou conexão remota. Para testar, a primeira carga insere os registros e as seguintes usam `INSERT OR IGNORE`, sem substituir dados. Qualquer conflito de ID/conteúdo ou diferença de contagem aborta a transação. A migração é versionada e tem seu SHA-256 registrado no banco local.

Os IDs UUID permanecem como texto; datas de negócio como `YYYY-MM-DD`; timestamps como texto ISO 8601; valores monetários em centavos como inteiros; percentuais de ocupação como texto decimal para preservar a representação original. Históricos e campos JSON são mantidos como JSON válido.

## Limite desta etapa

A validação usa o mecanismo SQLite local e SQL compatível com D1. Ela não cria um banco remoto na conta Cloudflare nem publica Workers. O arquivo local é apenas uma base de teste descartável/isolada; a aplicação e o banco oficial continuam inalterados.
