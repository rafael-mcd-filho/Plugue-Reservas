# Captura futura de data, horário e indisponibilidade

## Limite da primeira versão

O relatório **Demanda & Conversão** usa as cinco etapas já consolidadas no read model do funil. Hoje, `date_select` e `time_select` comprovam que a jornada avançou, mas os eventos históricos não garantem qual data ou horário foi escolhido. Também não existe evidência suficiente para afirmar que um horário indisponível foi procurado.

Por isso, a primeira versão não apresenta ranking de datas/horários procurados nem “demanda reprimida”. A interface informa esse limite e não transforma ausência de dado em zero.

## Captura proposta, isolada do Meta

A evolução deve manter os mesmos nomes de evento e acrescentar somente metadados analíticos opcionais:

- `date_select`: `selected_date`, `party_size`, quantidade de horários oferecidos e disponíveis e `no_availability` quando a consulta de disponibilidade tiver sido concluída;
- `time_select`: `selected_date`, `selected_time`, `party_size` e modo de capacidade observado;
- cobertura: versão da captura e indicador de disponibilidade efetivamente observada.

Arquivos previstos:

- `src/hooks/useFunnelTracking.ts`: aceitar metadados opcionais, preservando o envio fail-open;
- `src/components/ReservationModal.tsx`: fornecer apenas valores confirmados pela interface;
- `src/pages/CompanyPublic.tsx`: encaminhar os metadados sem alterar nomes de eventos;
- nova migration dedicada: agregar o perfil de seleção e sua cobertura sem modificar fila, worker, gatilhos ou mapeamentos Meta;
- testes de confiabilidade do tracking e regressão SQL: provar que `event_name`, fila CAPI e funções de mapeamento Meta permanecem idênticos.

## Regras de leitura

- Dados anteriores à implantação aparecem como “captura indisponível”, nunca como zero.
- Uma data só conta como sem disponibilidade quando a consulta terminou e retornou zero opções disponíveis.
- Botões de horário desabilitados não provam intenção de clique; portanto, não geram “horário procurado e indisponível”.
- A página deve exibir cobertura da captura antes de qualquer ranking, para evitar comparar períodos com instrumentação diferente.
- Falhas ao registrar metadados nunca podem bloquear o processo de reserva.

Essa evolução fica separada da primeira entrega para que seja validada com uma migration e testes próprios antes de qualquer publicação.
