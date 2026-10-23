---
name: Domínio de ocupação ZERO3 PRO
description: Regras atuais para registrar aulas, calcular ocupação e preservar dados antigos.
---

Cada novo registro representa uma aula com modalidade, data, horário inicial, horário final opcional, presenças e capacidade total. Calcular ocupação como soma das presenças dividida pela soma das vagas; não limitar resultados acima de 100%. Presenças somadas são participações em aulas, não clientes únicos.

**Why:** A especificação atual do produto substituiu o modelo anterior que recebia somente percentuais e não tinha capacidade ou presença.

**How to apply:** Usar presenças e vagas para os novos cálculos por dia, mês, trimestre, modalidade e horário. Aceitar 0 presenças e ocupação acima de 100%; nunca converter as participações em pessoas distintas.

Preservar registros legados que só têm percentual sem inventar presenças ou capacidade; mantê-los identificados à parte quando não puderem integrar o cálculo ponderado. Percentual informado na planilha serve para conferência: diferenças de arredondamento são aceitáveis, divergências relevantes precisam ser sinalizadas.

**Why:** O histórico antigo não contém dados de capacidade suficientes para reconstruir presenças ou vagas. O novo modelo exige cálculo ponderado, não média simples de taxas.

**How to apply:** Manter dados antigos e novos compatíveis durante a migração; ausência de registros nunca significa aula com zero presenças. Calcular taxas novas sempre com somas de presenças e vagas.

Ao misturar detalhe diário com resumo mensal, escolher a fonte por modalidade/turma/mês: o resumo substitui o detalhe apenas naquele mês; nos outros meses do trimestre, os registros diários continuam entrando. Resumos percentuais legados substituem somente percentuais legados do mesmo grupo e nunca se misturam às medições. Gráficos por horário ou dia da semana usam apenas registros diários, sem distribuir totais mensais por categorias que a fonte não informa.

**Why:** A planilha pode conter níveis de agregação diferentes; escolher a precedência no trimestre inteiro perde dados, somar ambos duplica valores, e repartir um resumo mensal por horário/dia inventaria informação.

**How to apply:** Resolver substituição dentro de cada mês antes de juntar meses em um trimestre. Para gráficos por horário e dia da semana, usar dados diários com esses atributos e manter totais mensais fora dessas quebras.

O modelo de aula não exige cliente, professor, venda ou cadastro individual de participantes. “Vagas” é capacidade total, não vagas restantes. Horário inicial distingue aulas da mesma modalidade no mesmo dia; horário final pode faltar.

**Why:** A ocupação é uma medida operacional por aula, e a mesma turma pode ter várias sessões no mesmo dia.

**How to apply:** Não vincular aulas a clientes ou vendas. Identificar duplicidades principalmente por modalidade, data e horário inicial, preservando aulas em horários diferentes.

CrossFit deve ser a modalidade inicial, mas filtros, importações e gráficos precisam continuar dinâmicos para outras modalidades. Associar nomes equivalentes como “CrossFit” e “CROSSFIT PRESENCIAL” somente após confirmação explícita.

**Why:** A especificação nova define CrossFit como início, sem tornar a aplicação exclusiva dessa modalidade.

**How to apply:** Reutilizar modalidades existentes e preservar registros ao renomeá-las; não inferir equivalência comercial apenas por semelhança textual.

Dados de teste não entram na base real.

**Why:** O usuário exigiu validação em ambiente isolado, preservando os registros existentes.

**How to apply:** Exercitar criação, edição e exclusão em armazenamento isolado, inclusive nos testes de navegador; apagar registros de teste da lista compartilhada depois não substitui isolamento.

O isolamento do navegador precisa cobrir também as rotas por ID e todos os verbos usados, não apenas a consulta de coleção.

**Why:** Uma interceptação de consulta funcionou, mas um PATCH por ID escapou para a API compartilhada e retornou 404. Não houve alteração real porque o ID só existia no esquema privado.

**How to apply:** Comprovar o destino das mutações antes do CRUD, falhar sem encaminhar à base compartilhada quando a ponte de teste falhar e verificar ausência dos IDs de teste na base real.

Não confiar somente na limpeza assíncrona por sinal de encerramento de um servidor de teste.

**Why:** Parar o processo em segundo plano encerrou o servidor sem concluir a remoção de seu esquema privado.

**How to apply:** Após parar, conferir a remoção e limpar explicitamente apenas o esquema identificado e validado como exclusivo de teste.

Excluir uma modalidade vinculada exige confirmação explícita: remover suas aulas e desvincular os produtos, mantendo as vendas sem classificação por essa modalidade.

**Why:** O usuário escolheu esse comportamento após ser informado de que aulas seriam apagadas e as associações dos produtos seriam removidas.

**How to apply:** A confirmação deve explicar que a ação é irreversível; manter a auditoria e atualizar as consultas de ocupação e vendas após concluir.
