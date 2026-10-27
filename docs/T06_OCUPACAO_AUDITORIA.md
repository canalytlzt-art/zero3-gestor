# T06 — auditoria de ocupação e gráficos

## Modelo atual confirmado

`occupancy_records` é a fonte oficial no backend PostgreSQL e no D1 do Worker. Cada linha guarda modalidade, tipo diário ou mensal, data/competência, percentual, turma, observação, versão e origem da importação. Registros diários medidos também guardam presenças, vagas e horário inicial; horário final é opcional. O histórico de alterações fica separado.

- Para registros com contagens, a API e o Worker calculam `presenças ÷ vagas × 100`, com seis casas decimais. Presenças podem ser zero; vagas precisam ser inteiras e maiores que zero.
- O schema permite contagens apenas em registros diários. Registros percentuais legados continuam válidos, inclusive mensais, sem criar presenças ou vagas artificiais.
- `reportedPercentage` guarda o percentual da planilha para conferência; ele não substitui o percentual calculado quando há contagens.
- Datas e competências usam `YYYY-MM-DD` e `YYYY-MM`. Modalidade e horário inicial compõem o escopo; aulas na mesma data em horários diferentes permanecem distintas.
- Um lançamento sem horário final é válido. Um registro diário medido exige horário inicial.

O schema D1 inicial e o schema PostgreSQL foram conferidos: preservam os campos acima, os vínculos de modalidade, a versão/histórico e a identificação de origem. Nenhuma migração foi criada ou aplicada nesta tarefa.

## Importação, cálculos e exportação

- O importador aceita linhas de registros, matrizes modalidade/mês e matrizes data/modalidade. Converte percentuais por formatação Excel, texto explícito ou escala confirmada por bloco; não assume silenciosamente um ano ausente nem multiplica todo número por 100.
- O arquivo, aba e célula de origem são mantidos. A prévia e a confirmação distinguem reimportação idêntica de conflito por origem ou escopo; não somam percentuais duplicados.
- Totais medidos usam a razão entre as somas: `1/2 + 9/10 = 10/12 = 83,33%`. Percentuais legados permanecem fora do denominador e são identificados como percentual informado ou média simples.
- Em vistas mensal/trimestral, um consolidado substitui o detalhe apenas no mesmo mês, modalidade, turma e base de cálculo. Intervalos que não cobrem meses completos não recebem o consolidado mensal. Resumos mensais não são atribuídos a horários nem dias da semana.
- Zero é um valor válido; ausência de registro é `null`/“Sem dados”. Valores medidos acima de 100% são preservados e sinalizados.
- O relatório mantém linhas detalhadas e resumos sem somar percentuais. Os testes existentes validam o XLSX de ida e volta pelo importador e a exportação de mais de 500 registros.

## Ajuste desta auditoria

O gráfico de rosca podia transformar médias de percentuais legados — inclusive de modalidades diferentes — em “ocupado/complemento”, o que sugeria um total comum sem denominador compartilhado. Agora a rosca exige contagens agregáveis ou uma única observação percentual, de uma modalidade e período definidos. Comparações de percentuais legados continuam disponíveis nas barras/evolução com a base identificada.

## Limites da validação desta etapa

Os testes padrão agora incluem as suítes sintéticas de importação, gráficos e relatórios. Elas cobrem zero versus ausência, escala de percentual, datas/competências, precedência diário/mensal, intervalos parciais, horários distintos, ponderação, sobrelotação e ida e volta do relatório.

Não foi consultado o banco D1 nem executada a suíte de integração PostgreSQL: o D1 isolado ainda depende da autenticação do Wrangler, e as suítes de integração criam schemas temporários no banco configurado. A persistência real após importação e nova consulta continua pendente de um banco de teste isolado.
