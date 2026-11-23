# Intermediação e saques das reservas

Publicado em produção em 08/11/2026, após autorização expressa do usuário, em [plugguest.com.br](https://plugguest.com.br). Foram aplicadas as três migrations desta entrega, publicadas sete funções Edge e promovido o frontend `dpl_6BheXEh6D2EoCSWwER8qq6xGfzrL`. A restrição anterior de manter a implementação apenas local foi substituída por essa autorização. Nenhuma cobrança, devolução, solicitação de saque ou transferência real foi criada para testar.

A conta Asaas central está configurada em produção. Nenhuma taxa por empresa foi criada automaticamente e nenhum saldo histórico foi importado. Antes de habilitar a primeira regra de uma empresa real, configurar em **Superadmin → Repasses → Taxas por empresa** o percentual, a vigência, a política de liberação e **Autorizar novas cobranças**.

Ainda em 08/11/2026, foi publicada a revisão dos textos em `dpl_8QA5mMtxm3P75hijUF19Cpo2ixo8`: as telas da empresa, menu, exportação e mensagens de pagamentos usam linguagem neutra, sem identificar o processador. Os detalhes da integração permanecem no superadmin. O controle **Autorizar novas cobranças** ganhou explicação de regras, taxa, vigência e preservação dos pagamentos, saldos e saques existentes. Não houve alteração de regras financeiras, banco ou funções Edge. Passaram 32 testes das telas, build isolado e verificação das quatro abas em produção, em desktop e celular, sem envio de formulários. Evidências privadas: diretório indicado por `supabase/.temp/payment-copy-release-path.txt`.

Em 09/11/2026, a revisão visual `dpl_C9o1EBaXdozyVJTW7ckf8DUAriiS` compactou o dashboard acumulado. A medição em produção passou de 360 para 175 px de altura em desktop de 1.440 px e de 737 para 385 px no celular de 390 px. O saldo disponível continua destacado; os quatro indicadores aparecem lado a lado no desktop e em duas colunas no celular. As explicações ficam no detalhe recolhido, mantendo avisos financeiros visíveis. Foram preservados os valores do servidor, permissões, filtros e ações de saque. Passaram 17 testes existentes, build isolado e conferência visual em 1.920, 1.440, 1.024, 390 e 320 px, incluindo valores altos, saldo negativo e condições desabilitadas. A verificação no domínio principal abriu as quatro abas sem envio de formulários, erros de página ou transbordamento. Nenhuma migration ou função Edge foi alterada. Evidências privadas: diretório indicado por `supabase/.temp/compact-balance-release-path.txt`.

Ainda em 09/11/2026, a publicação `dpl_FJpmh19g7JFSTxdyVsebRtfq5VF9` adicionou taxas distintas de Pix e cartão por empresa e fixou novos pagamentos no cartão em parcela única. Foram aplicadas as migrations `20261109130000_add_reservation_method_fees.sql` e `20261109131000_require_single_card_reservation_payments.sql`, publicadas seis funções Edge e o frontend. A aplicação atômica confirmou a preservação dos 1.205 pagamentos, 3.097 eventos e registros financeiros existentes. Não foram escolhidos percentuais novos, criadas cobranças, estornos, saques ou transferências de teste. Backups, fontes publicadas, verificações e recibo estão no diretório privado indicado por `supabase/.temp/method-fees-release-path.txt`.

## Condições comerciais

O superadmin define uma condição por empresa: percentuais de Pix e cartão em pontos-base (1.000 = 10%), vigência, habilitação e regra de liberação. Em **Superadmin → Repasses → Taxas por empresa**, os dois percentuais são preenchidos separadamente, com até duas casas decimais e limites de 0% a 100%. Por exemplo, em R$ 2.000, Pix a 2% resulta em R$ 1.960 e cartão a 10% em R$ 1.800 para a empresa. As tarifas Asaas são custo da plataforma, incluído na intermediação de cada método.

As duas taxas são preservadas quando cada novo pagamento elegível nasce, antes da escolha do método. A taxa efetiva é vinculada uma única vez ao método local e à cobrança consultada na API, respeitando a ordem das observações; consultas atrasadas não substituem uma divergência mais recente. Mudar condições depois disso não recalcula cobranças anteriores. Registros financeiros anteriores à mudança preservam a taxa única original; na leitura de condições antigas, esse percentual vale para os dois métodos. Uma aba antiga não pode sobrescrever silenciosamente uma condição já configurada com percentuais diferentes.

A política inicial da interface é liberar após disponibilidade no Asaas e após o dia da reserva, considerando `America/Sao_Paulo`, com prazo adicional configurável. O superadmin também pode escolher disponibilidade no Asaas sem esperar pela reserva. Nenhuma taxa é ativada automaticamente para empresas existentes.

**Autorizar novas cobranças** controla a aceitação de novas antecipações na conta central em produção. Sem uma condição comercial vigente e habilitada, a criação é bloqueada antes da reserva pendente e da cobrança, evitando receber dinheiro sem vínculo financeiro. Desabilitar não apaga nem recalcula cobranças, saldos ou saques existentes. Os fluxos legados e de sandbox mantêm seu comportamento separado.

## Saldos e conciliação

Cobrança aprovada para confirmar reserva e dinheiro disponível para saque são informações distintas. O financeiro guarda lançamentos permanentes em centavos, com saldos a liberar, disponíveis, em conferência, reservados em saques e já pagos. A taxa do provedor não reduz a parcela contratada da empresa.

Somente novas cobranças da conta central em ambiente de produção, criadas com uma condição comercial habilitada, recebem um vínculo financeiro. A migração não importa saldos antigos. Contas legadas, sandbox, recebimentos manuais em dinheiro, valores sem líquido conhecido, pagamentos tardios em revisão e eventuais registros antigos parcelados não geram liberação automática.

Webhooks, consultas manuais e conciliação verificam o pagamento na API da conta vinculada antes de atualizar a posição financeira. Uma rotina própria acompanha esses registros sem o limite de idade do reconciliador de reservas. Falha de verificação ou observação desatualizada impede saque até nova conciliação.

Estorno pendente retém o valor; conclusão reverte proporcionalmente a comissão. Chargebacks e devoluções posteriores ao repasse podem gerar saldo negativo, compensado por novos recebimentos. Pedidos ainda não iniciados não podem avançar ao pagamento se o saldo ficou comprometido. Uma transferência já realizada deve ser registrada com seu comprovante mesmo que uma devolução posterior tenha gerado saldo negativo.

## Pedidos e comprovantes

A empresa cadastra um destino Pix ou bancário e solicita um valor dentro do saldo disponível. O destino é copiado para o pedido, sem alterações retroativas. O pedido reserva saldo em uma transação serializada por empresa, com chave de idempotência para repetição de requisições.

Fluxo: solicitado → em análise → em pagamento → pago. Antes de iniciar pagamento, o pedido pode ser recusado pelo superadmin ou cancelado pela empresa, liberando a reserva. Durante pagamento, não há liberação automática por erro ou dúvida sobre a transferência.

O pagamento é manual. O sistema não chama a API de transferências do Asaas. Conclusão exige referência bancária, data e comprovante existente em armazenamento privado. Comprovantes PDF, PNG ou JPEG têm limite de 5 MB, não são sobrescritos e são baixados por URL temporária após autorização da empresa ou do superadmin.

Operadores e sessões delegadas de suporte não têm acesso a dados de destino, comprovantes ou movimentações de repasse. O superadmin real pode acessar essas funções ao impersonar o administrador da empresa; a interface valida ator, empresa, papel e sessão ativa, e o backend continua autorizando e registrando o superadmin real pelo JWT. Um marcador local de impersonação não concede permissões a administradores comuns ou suporte. Durante a ativação da sessão a tela mostra carregamento, e mudanças de sessão atualizam as permissões sem recarregar a página. O histórico financeiro impede exclusão destrutiva da empresa; a prevenção ocorre antes dos lotes de exclusão e da quarentena. A empresa pode ser desativada preservando seus registros.

## Telas

- Empresa → Pagamentos das reservas: dashboard acumulado acima das abas, com saldo disponível, total confirmado, líquido da empresa, saques pagos, reservados, valores a liberar e em conferência. A ordem é Resumo financeiro (inicial), Pagamentos, Saques e Regras. A análise por período fica abaixo do dashboard e não muda seu saldo.
- Nova regra é uma ação que abre um formulário em diálogo; os filtros de regras são apenas Ativas, Desativadas e Arquivadas. A aba Saques mantém destino, solicitação, cancelamento, histórico e comprovante, sem repetir o dashboard.
- Superadmin → Repasses: fila de pedidos, condições por empresa, custo Asaas separado da intermediação, registro de pagamento e comprovante.
- O saldo é acumulado e independente dos filtros de período das cobranças.

## Validação local

Os testes usam respostas falsas do provedor e PostgreSQL isolado via PGlite; não utilizam credenciais financeiras reais. Executar as suítes de saques, pagamentos antecipados, verificação Deno e build antes de preparar qualquer futura publicação autorizada.

Comandos reproduzíveis: `npm run test:settlements`, `npm run test:prepayments`, `npm test -- --reporter=dot` e `npm run build`. Após a reorganização das telas e o ajuste da impersonação, a suíte completa de frontend passou com 132 arquivos e 1.106 testes. A verificação Deno das funções alteradas passou; a verificação global TypeScript ainda apresenta 50 diagnósticos anteriores em outros módulos, sem diagnósticos nos arquivos desta implementação. A suíte nova inclui contrato real API → SQL e replay de todas as 235 migrations com o fluxo de confirmação, saque, comprovante, estorno, ACLs e cron substituído por um registrador local inerte.

Houve conferência visual com API simulada em 1.440 e 390 pixels, sem erros de página ou transbordamento horizontal. Relatório e capturas estão em `supabase/.temp/settlement-ui-visual-report.json` e `supabase/.temp/settlement-*.png`. Nenhum backend externo foi acessado nessa conferência.

A reorganização das telas foi conferida em 1.920, 1.440 e 390 pixels com dados simulados: saldo constante ao mudar abas e filtros de data, abertura dos formulários de regra/saque e acesso do superadmin impersonando administrador. Relatório: `supabase/.temp/prepayment-redesign-visual-report.json`; capturas: `supabase/.temp/prepayment-redesign-*.png`. Sem chamadas externas, erros de página ou transbordamento horizontal. O saldo usa `available_cents` do servidor; o total confirmado não é apresentado como dinheiro já disponível.

As migrations desta entrega são `20261108190000_add_reservation_settlements_and_withdrawals.sql`, `20261108191000_guard_financial_company_deletion.sql` e `20261108192000_schedule_reservation_settlement_reconciliation.sql`. Todas foram aplicadas em produção. Funções novas publicadas: `manage-reservation-settlements` e `reconcile-reservation-settlements`. Também foram publicadas as integrações nos fluxos de criação, webhook, consulta, estorno e conciliação das reservas.

## Verificação da publicação de 08/11/2026

O ensaio das migrations terminou em `ROLLBACK`, seguido de aplicação atômica e registro das versões. Os 1.204 pagamentos e 3.094 eventos financeiros existentes foram preservados; as seis tabelas novas permaneceram vazias ao final da verificação. Não foram ativadas funcionalidades de antecipação para empresas reais.

As fontes das sete funções publicadas foram baixadas e comparadas ao snapshot validado. Os jobs de expiração, conciliação de pagamentos e exclusão de empresas foram restaurados ao estado ativo; o novo job de conciliação financeira executa a cada cinco minutos. O armazenamento de comprovantes é privado, e as tabelas e funções financeiras internas recusam acesso direto dos clientes.

Os testes de produção verificaram autenticação, isolamento entre empresas, negação de operações sem permissão e o painel da empresa de teste em 1.440 e 390 pixels. O resumo abre primeiro, o saldo vem do backend e os formulários de destino e regra abrem sem envio. Não houve transbordamento horizontal ou erros de página. A conta de teste continuou sem condição comercial, saldo ou pedidos de saque.

Os backups privados, manifestos, fontes anteriores, plano de reversão e recibo `release-receipt.json` estão no diretório indicado por `supabase/.temp/settlements-release-path.txt`. Esses arquivos não devem ser publicados nem adicionados ao repositório. A reversão operacional exige conferir a ausência de movimentações novas; havendo histórico financeiro, priorizar correção que preserve os registros.

Novas regras e cobranças de cartão são sempre à vista, em parcela única. O campo de parcelas foi removido; banco e funções também aplicam o limite, inclusive para clientes antigos e cobranças ainda sem método escolhido. Os links novos usam `chargeType=DETACHED`, sem `maxInstallmentCount`. Snapshots, links e pagamentos antigos não são reescritos; um eventual histórico parcelado continua sujeito à conferência manual e não é liberado automaticamente. A verificação anterior à publicação não encontrou regras ou pagamentos parcelados na produção. Uma eventual abertura de saldo histórico exige outro procedimento, explícito e conciliado.

A entrega de taxas por método e cartão à vista passou na suíte completa de frontend (132 arquivos, 1.108 testes), nas suítes de intermediação e antecipação, em dez runners SQL incluindo o replay de 237 migrations e na verificação Deno dos seis endpoints preparados. Os 50 diagnósticos globais TypeScript anteriores permanecem fora dos arquivos alterados. As telas foram conferidas com dados simulados em 1.440, 390 e 320 px, incluindo exemplos líquidos de cada método e manutenção da altura compacta do dashboard. Não houve chamadas externas nessa conferência.

Após a publicação, as fontes das seis funções foram baixadas e comparadas ao pacote preparado, com autenticação preservada. A API real confirmou leitura das condições antigas, isolamento entre empresas e recusa de alterações de taxa por administradores comuns ou RPC direto. No domínio principal, a empresa de teste exibiu ambas as taxas e o formulário de regra sem campo de parcelas, em desktop e celular, sem envio de formulários ou operações financeiras. As três rotinas de expiração e conciliação permaneceram ativas após a atualização.
