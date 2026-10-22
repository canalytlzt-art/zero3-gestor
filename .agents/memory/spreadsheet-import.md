---
name: Importação de planilhas de vendas
description: Semântica exigida para os dados de origem e armadilha de codificação de CSV.
---

## Semântica da origem

A planilha de origem pode ter somente nome do cliente, **Data de início** e valor total da venda. Produto/categoria não é obrigatório e a ausência não deve gerar um produto fictício. Data de início é a data da venda, não vencimento, pagamento ou cadastro.

**Why:** O usuário exigiu que arquivos com apenas esses três campos sejam importáveis e que a categoria possa ser atribuída depois.

**How to apply:** Não volte a exigir quantidade, preço unitário ou cadastro comercial para aceitar a origem. Quando houver várias datas, preserve essa distinção e permita revisar o mapeamento.

## CSV e acentos

Ler bytes de CSV UTF-8 diretamente com SheetJS neste ambiente produziu texto corrompido como “inÃ­cio”; remover acentos depois não recupera o cabeçalho.

**Why:** A interpretação implícita da codificação impedia reconhecer Data de início mesmo quando a coluna estava presente.

**How to apply:** Decodifique o texto explicitamente antes de entregar CSV ao leitor. Mantenha fixtures com acentos nos cabeçalhos e nomes, além de valores monetários com vírgula.
