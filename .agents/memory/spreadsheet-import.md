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

## Linhas modelo não são vendas

A origem pode ter Modalidade/Recorrência pré-preenchidas mesmo sem lançamento. Uma linha não vira candidata financeira apenas por conter esses textos.

**Why:** A planilha real produzia falsas pendências porque linhas modelo eram tratadas como vendas com três campos faltantes.

**How to apply:** Examine todas as células antes de classificar; se só houver conteúdo auxiliar, conte à parte e não selecione. Havendo indício real de venda, preserve os campos encontrados e deixe somente a pendência verdadeira.

## Fórmula sem resultado calculado

SheetJS pode retornar uma fórmula sem cache como `t: "z", v: 0`. Esse zero é um marcador, não um valor financeiro calculado.

**Why:** Um teste com fórmula sem elemento de resultado no XLSX foi inicialmente interpretado como venda de zero reais.

**How to apply:** Considere o tipo da célula junto com fórmula e cache; não aceite o marcador como valor. Fórmulas com cache numérico real, inclusive zero, continuam válidas.

## Reprocessamento parcial

Concluir uma seleção não encerra o arquivo inteiro: o mesmo arquivo pode ter outras abas/linhas ainda não importadas.

**Why:** O usuário exigiu complementar importações sem repetir o que já entrou, sem deduplicar vendas legítimas por nome/valor.

**How to apply:** Mantenha a identidade persistente da origem física e consulte-a antes de selecionar linhas; a verificação precisa ser repetida sob proteção de concorrência no servidor.

## Datas e identidade de rascunhos no Worker

As validações OpenAPI geradas usam `z.coerce.date()` para campos com `format: date`, então handlers recebem `Date`, mesmo quando o JSON continha uma data ISO curta. Para manter a data de calendário, converta a instância `Date` para `toISOString().slice(0, 10)` antes de validar/gravar.

**Why:** A validação de data só com string recusava datas válidas depois da coerção do schema e impedia confirmar rascunhos.

**How to apply:** Ao adicionar rotas com datas geradas pelo OpenAPI, trate explicitamente `Date` e string, preservando o dia UTC sem conversão local.

Índices únicos parciais do D1 não aceitam necessariamente `ON CONFLICT(coluna...)` sem o predicado correspondente. Para a origem opcional de arquivo/aba/linha, use `INSERT OR IGNORE` ou replique exatamente o predicado do índice.

**Why:** O identificador de origem fica nulo em rascunhos manuais; o índice parcial garante idempotência apenas para registros importados.

**How to apply:** Ao persistir linhas de importação com chave natural coberta por índice parcial, mantenha a inserção idempotente compatível com a definição real do índice.

## Pendências no backend Express de desenvolvimento

O backend Express/PostgreSQL do preview persiste pendências de importação como eventos `sales-pending-draft` em `sales_history`; o Worker Cloudflare mantém sua tabela D1 dedicada.

**Why:** A interface do preview usa o Express, enquanto a publicação usa o Worker. Reutilizar o histórico existente evitou uma migração adicional do PostgreSQL e manteve os rascunhos fora das consultas financeiras.

**How to apply:** Preserve o filtro por tipo/operação ao consultar histórico e Scoreboard. Se a modelagem PostgreSQL mudar, mantenha a identidade de origem por arquivo/aba/linha, atualização com versão e conversão única para venda.
