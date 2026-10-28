---
name: Ciclo de vida dos produtos
description: Regra para inativar produtos sem apagar o histórico financeiro.
---

Remover um produto da oferta significa inativá-lo, nunca excluí-lo permanentemente. Vendas, estornos, metas e histórico precisam permanecer associados ao cadastro existente.

**Why:** O usuário escolheu explicitamente preservar todos os dados financeiros ao retirar um produto de uso.

**How to apply:** Exigir confirmação antes de inativar e permitir reativação pelo fluxo de edição existente.

## Cadastro automático

Vendas e importações confirmadas podem criar um produto ausente. Compare nomes após remover espaços excedentes e ignorar maiúsculas/minúsculas; não faça junções aproximadas. Produtos automáticos começam com preço sugerido zero, sem inferir preço a partir de vendas. Cadastros existentes e seus preços não devem ser sobrescritos.

**Why:** O usuário exige produtos novos ligados às vendas confirmadas, sem duplicatas por caixa/espaçamento e sem transformar valores variáveis de venda em preços sugeridos.

**How to apply:** Aplique a mesma normalização em lançamentos manuais, importações e backfills. Crie o produto junto da gravação confirmada, mantendo a chave normalizada única e deixando o campo de preço sugerido para edição explícita.
