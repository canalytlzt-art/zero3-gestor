# T05 — Contrato financeiro confirmado no código

Esta nota registra o comportamento atual antes de ampliar ou corrigir a validação. Não define uma nova política contábil.

## Lançamentos e importação

- Valores de venda são persistidos como centavos inteiros; a quantidade é inteira e positiva.
- No cadastro manual, o total precisa corresponder à quantidade multiplicada pelo valor unitário.
- O esquema atual não possui um campo separado de desconto. Não inferir nem criar desconto durante a importação.
- A importação exige nome do cliente, data de venda e valor total. Produto/plano é opcional; sem classificação, a venda continua nos totais como **Não categorizado**.
- Na importação, a quantidade é 1 e o valor importado é preservado em `unitAmountCents` e `totalCents`.
- A data de venda é a data de negócio. Datas são validadas como calendário antes da conversão do schema e não podem mudar por fuso.
- A origem é identificada por hash do arquivo, aba e linha. Duas linhas físicas diferentes podem ser vendas legítimas com mesmo cliente, data e valor.

## Cancelamentos, estornos e totais

- Vendas canceladas não integram o faturamento ativo.
- Estornos ativos vinculados a vendas ativas reduzem o líquido; sua data de movimento é `refundDate`, não a data da venda original.
- O Scoreboard soma quantidade e vendas pela data da venda; soma estornos pela data do estorno; líquido é vendas menos estornos.
- Filtros mensais usam ano/mês; intervalo inclui as duas datas. A interpretação de mês atual usa `America/Sao_Paulo`.
- Produtos sem classificação permanecem no total geral; nenhum erro ou valor ausente deve ser convertido silenciosamente em zero.

## Relatórios e gráficos

- Os gráficos financeiros são derivados da resposta do Scoreboard oficial e verificam reconciliação por produto e por mês.
- Participação em pizza/rosca inclui apenas vendas positivas. Valores líquidos negativos permanecem em visualização adequada, como a evolução mensal.
- A planilha é calculada sobre os registros e filtros selecionados: vendas pela data da venda, estornos pela data efetiva e valores em centavos até a exportação.

## Escopo de validação T05

- Fixtures sintéticas cobrem importação em múltiplas abas, linhas de vendas iguais mas legítimas, reimportação idempotente, estorno em mês posterior, Scoreboard, gráficos e planilha.
- A suíte padrão não abre a planilha original anexada. A validação real dessa origem permanece separada e exige execução explícita do teste correspondente.
- Os testes desta etapa não conectam ao D1 remoto nem executam migrações.
