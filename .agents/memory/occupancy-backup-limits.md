---
name: Limites de backup de ocupação no Worker
description: Invariantes de escopo, memória e contagens para backups de ocupação gerados pelo Cloudflare Worker.
---

Filtre os registros no D1 antes de montar o backup; limite os candidatos a 50.001 para recusar explicitamente mais de 50.000 registros e mantenha o limite do arquivo alinhado em 8 MiB entre Worker, leitor e API. `totalRecords` deve ser igual à quantidade dentro do arquivo. O resumo usa os registros efetivos: um intervalo parcial não inclui resumo mensal e um registro mensal substitui o legado diário do mesmo escopo.

**Why:** Ler todo o histórico no Worker pode exceder memória/tempo, e contagens de todo o banco tornam o arquivo parcial incompatível com o leitor de restauração.

**How to apply:** Ao alterar filtros, resumos ou limites de backups de ocupação, mantenha a seleção D1, o predicado final, o manifesto e o parser cliente em paridade; cubra mês vazio, intervalo parcial e registros duplicados diário/mensal com fixtures sintéticas.
