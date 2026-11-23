# Pagamentos antecipados de reservas — conta Asaas central

Estado atual em 08/11/2026: conta Asaas central configurada em produção. A entrega inicial de 07/11/2026 publicou quatro migrations, dez funções Edge e o frontend. Após nova autorização expressa, a entrega de intermediação e saques publicou mais três migrations, sete funções Edge e o frontend `dpl_6BheXEh6D2EoCSWwER8qq6xGfzrL` em [plugguest.com.br](https://plugguest.com.br). Nenhuma cobrança, devolução, solicitação de saque ou transferência real foi criada para testar essas publicações.

As taxas são configuradas em **Superadmin → Repasses → Taxas por empresa**, incluindo vigência, liberação e **Autorizar novas cobranças**. Nenhuma taxa foi criada automaticamente e nenhum saldo histórico foi importado. A revisão posterior dos textos, publicada em `dpl_8QA5mMtxm3P75hijUF19Cpo2ixo8`, removeu a identificação do processador das telas da empresa e esclareceu esse controle, mantendo os detalhes técnicos no superadmin. Detalhes da entrega financeira estão em [Intermediação e saques](reservation_settlements_local.md).

Atualização de 09/11/2026: o frontend `dpl_FJpmh19g7JFSTxdyVsebRtfq5VF9` permite definir taxas distintas para Pix e cartão. Novos pagamentos no cartão são exclusivamente à vista, em parcela única, com limite aplicado no banco e na geração do link. As condições antigas mantêm a taxa original para os dois métodos, e os pagamentos anteriores preservam a taxa já contratada. Foram aplicadas duas migrations adicionais e publicadas seis funções Edge, com verificações descritas no documento de intermediação.

## Correção do cadastro de webhook — 08/11/2026

O primeiro cadastro com o token retornou `O evento [PAYMENT_RECEIVED_IN_CASH] é inválido.` A lista enviada ao Asaas incluía esse nome indevidamente: o recebimento em dinheiro gera `PAYMENT_RECEIVED`, com `billingType = RECEIVED_IN_CASH`, conforme a [documentação oficial de eventos](https://docs.asaas.com/docs/webhook-para-cobrancas).

Foi removido somente o evento inválido. Os outros 14 eventos foram conferidos na documentação. A função `manage-reservation-asaas-config` foi publicada na versão 2, ativa e com autenticação JWT preservada; os oito arquivos TypeScript do pacote publicado foram conferidos contra a versão preparada. Nenhuma migration ou alteração no frontend foi necessária.

Os testes de criação, atualização e inspeção do webhook reproduziram a falha antes do ajuste e passaram depois. A suíte de backend passou com 53 testes, e a verificação de tipos Deno passou. A tentativa anterior não persistiu token, conta ou webhook; foi necessário reenviar a credencial usando **Salvar e configurar webhook**. Na verificação da publicação financeira de 08/11/2026, a conta central já estava configurada em produção. Nenhuma cobrança ou devolução foi criada durante a correção.

## Configuração no superadmin

Em **Integrações → Asaas — pagamentos das reservas**, o superadmin informa:

- Token da única conta Asaas que receberá as reservas de todas as empresas.
- Ambiente correspondente ao token: Sandbox ou Produção.
- E-mail para avisos do Asaas sobre a entrega dos webhooks.

**Salvar e configurar webhook** valida a credencial, identifica a conta pelo WalletId e cria ou atualiza um único webhook central. O botão **Testar integração** verifica a configuração salva e o webhook. Testar um token digitado ainda não instala o webhook: é necessário salvar. URL, ID e e-mail do webhook ficam disponíveis em seus detalhes.

O token de API é criptografado no servidor. A autenticação do webhook é gerada e gerenciada pelo sistema; nenhum desses segredos é devolvido aos painéis das empresas. O superadmin não precisa cadastrar um webhook para cada empresa.

O webhook central usa uma URL própria, terminada em `asaas-webhook?scope=platform`, para preservar os webhooks antigos. Quando o token central recebe eventos de cobranças legadas da mesma conta, o sistema verifica a cobrança na API dessa conta antes de aplicar alterações. Eventos fora do escopo são reconhecidos sem alterar pagamentos e sem interromper as filas antigas.

Essa configuração de recebimentos é separada da integração de mensalidades da plataforma. Pode usar a mesma conta Asaas, mas não altera vínculos, cobranças ou sincronização das mensalidades.

## Vínculo e conciliação por empresa

Cada antecipação guarda `company_id`, `reservation_id`, referência externa, ID do link/cartão ou da cobrança Pix, método, valor, prazo e situação. A descrição enviada ao Asaas inclui os IDs da empresa e da reserva, nome da empresa, referência da reserva, data, horário, cliente e regra, respeitando 500 caracteres.

As novas cobranças também guardam o WalletId e o ambiente da conta central. Cobranças antigas permanecem vinculadas à conta da empresa em que foram criadas. Uma troca de token da mesma conta é permitida; trocar de conta ou ambiente com histórico central é bloqueado para não consultar ou estornar IDs na conta errada.

O webhook resolve a empresa pelos identificadores salvos. A confirmação e os desfechos financeiros são persistidos por transações no banco. Uma notificação repetida não confirma novamente; notificações com falha podem ser reprocessadas. O cron concilia cobranças existentes mesmo se sua regra estiver desativada ou arquivada.

O pedido de estorno reserva uma única solicitação por cobrança antes de chamar o Asaas. Requisições simultâneas não repetem a devolução. Se a resposta for inconclusiva, o pagamento permanece com estorno pendente e deve ser consultado; não se repete automaticamente uma operação financeira de resultado desconhecido. Somente estornos com `refunds.status = DONE` entram no valor devolvido.

O recurso de antecipação precisa estar habilitado para a empresa, e uma regra ativa precisa abranger a data da reserva. Novas cobranças centrais em produção também exigem uma condição comercial vigente e habilitada em Repasses. Apenas salvar o token central não passa a exigir pagamento em todas as reservas.

Durante a transição, empresas que já possuem uma conta Asaas configurada continuam usando essa conta até a primeira configuração central. Depois de inicializada a conta central, uma falha de validação não provoca retorno automático à conta antiga. Cobranças já criadas mantêm a conta original para consulta e estorno.

## Painel da empresa

O painel abre em **Resumo financeiro**, seguido de **Pagamentos**, **Saques** e **Regras**. Acima das abas, o dashboard mostra saldos acumulados, independentes dos filtros de período. Criar regra é uma ação em diálogo, sem uma aba exclusiva de criação. Token, webhook e situação técnica da integração ficam no superadmin. A empresa não consulta nem configura essa integração.

O painel mostra apenas suas próprias cobranças, protegido por RLS, com lista paginada completa, filtros, IDs/referências Asaas e exportação Excel. Inclui pagos/confirmados, pendentes, expirados, cancelados, estornos e chargebacks. Uma falha de consulta mostra erro em vez de apresentar zero como total.

Os indicadores seguem a ordem **confirmados brutos − estornos concluídos − chargebacks = após devoluções**. A quantidade de pagamentos acompanha o valor bruto; estornos pendentes, cobranças pendentes, expiradas e canceladas ficam em acompanhamento, sem subtração duplicada. O gráfico não soma o estorno ainda pendente novamente ao pagamento confirmado.

O administrador da empresa continua podendo consultar status individualmente e em lote, exportar registros e solicitar estorno integral de pagamentos à vista em `paid` ou `late_paid`, com confirmação. O cancelamento da reserva é uma operação separada e não movimenta dinheiro. Operadores não recebem permissão de estorno; suporte com sessão válida de administrador mantém o escopo da empresa. A API aceita estorno parcial, mas a tela atual solicita o integral; complemento de estorno parcial e parcelamentos exigem conferência no Asaas.

Os totais filtrados do resumo são a **posição atual das cobranças**, em valores brutos confirmados, antes da liquidação e das taxas Asaas. São separados do dashboard acumulado e do saldo disponível do módulo financeiro. Uma mudança de status pode mudar o período em que o valor aparece no resumo. Cancelar a reserva não estorna dinheiro automaticamente.

## Limitações que impedem tratar o módulo como conciliação bancária completa

- Intermediação, saldo disponível, retenções e pedidos de saque são calculados pelo módulo financeiro para novas cobranças centrais elegíveis. As tarifas Asaas ficam dentro da taxa da plataforma. Saldos históricos não foram importados, transferências são manuais e antecipações de recebíveis não são executadas pelo sistema.
- O histórico do resumo usa a posição atual; não substitui um livro de movimentos financeiros imutáveis por data de entrada e saída.
- Parcelamento possui várias cobranças no Asaas. O sistema preserva os IDs observados, sinaliza conferência manual e não aplica o estorno/cancelamento de uma parcela ao valor integral da reserva. O estorno automático pelo painel é bloqueado para parcelamentos; o parcelamento completo deve ser conferido e estornado no Asaas. A conciliação automática de todas as parcelas continua pendente.
- Pagamento confirmado não significa dinheiro já disponível na conta. Pagamento tardio ou de reserva cancelada exige revisão quando não for possível confirmar a reserva com segurança.

O fluxo atual permite Pix e cartão à vista. Parcelamento foi retirado por decisão do usuário em 09/11/2026; referências a parcelas nesta seção descrevem exclusivamente o tratamento defensivo de um eventual histórico antigo.

## Artefatos para futura homologação

As quatro migrations desta seção foram aplicadas em produção; as migrations anteriores do projeto já estavam instaladas. Para reproduzir a homologação, usar um Supabase isolado.

Novas migrations:

1. `20261107120000_add_central_reservation_asaas_config.sql`: configuração central, proteção de conta/ambiente e remoção de escrita financeira direta por usuários das empresas.
2. `20261107141000_harden_reservation_payment_lifecycle.sql`: confirmação/desfechos transacionais, processamento de notificações e cron de conciliação.
3. `20261107143000_require_public_reservation_prepayment.sql`: impede criar reserva pública pulando o pagamento e criar pendências públicas sem registro financeiro.
4. `20261107150000_preserve_reservation_payment_history.sql`: impede excluir isoladamente reservas com histórico de pagamento. A entrega financeira posterior também passou a impedir exclusão destrutiva de empresas com registros de intermediação ou saques; cancelar reservas continua permitido, sem estorno automático.

Funções afetadas: `manage-reservation-asaas-config`, `save-asaas-config`, `create-reservation-payment`, `select-reservation-payment-method`, `check-reservation-payment`, `asaas-webhook`, `expire-reservation-payments` e `reconcile-reservation-payments`, `refund-reservation-payment`, junto com os arquivos compartilhados. Publicar funções e frontend compatíveis somente depois das migrations no ambiente de homologação.

Configuração do servidor: `PLATFORM_BILLING_TOKEN_ENCRYPTION_KEY` para criptografia, `SUPABASE_URL`, `APP_URL` ou `SITE_URL` com o domínio público da reserva e o segredo interno dos jobs. Os jobs ainda exigem `system_settings.internal_job_secret`. Para a conta central, a URL Asaas é escolhida pelo ambiente salvo; `ASAAS_API_BASE_URL` continua restrita à compatibilidade de contas antigas.

Os jobs de expiração e conciliação usam `project_url` da configuração central, preenchida automaticamente pelo servidor ao salvar a integração. Sem essa URL, os jobs não fazem chamadas. Não há fallback para o projeto de produção nas novas agendas; a homologação precisa usar o próprio Supabase e o próprio segredo interno.

## Validação local

Rodar `npm run test:prepayments` para os testes focados de frontend, funções e banco local. `npm run build` valida o empacotamento do frontend.

Na preparação final, passaram 24 testes frontend, 50 testes backend, as quatro rotinas SQL locais, o build e a verificação Deno das dez funções afetadas. A suíte completa de frontend passou com 1.078 testes em 127 arquivos. O `tsc` global do projeto ainda apresenta erros anteriores de tipos Supabase em outros módulos; isso continua sendo uma pendência do repositório. O replay completo das migrations passou pela criação dos objetos e depois encontrou uma fixture antiga de telefone incompatível com a migração de DDI; as regressões específicas usam telefones e contexto compatíveis.

Antes de liberar o piloto em Sandbox, validar entrega real do webhook, Pix pago, cartão à vista, notificação duplicada, expiração, pagamento tardio, estorno total/parcial, cancelamento externo, indisponibilidade do Asaas e isolamento entre duas empresas. Confirmar que cada registro e sua referência correspondem ao painel correto e que os jobs apontam apenas para o ambiente de testes.

## Publicação de 07/11/2026

Registro histórico do estado naquela publicação; a configuração central e as telas foram atualizadas posteriormente, conforme o estado atual no início deste documento.

- Backup privado das fontes antigas das nove funções existentes, das definições SQL/ACLs/jobs e de 1.204 pagamentos e 3.094 eventos financeiros. A nova função central também foi incluída no manifesto da entrega.
- Ensaio das quatro migrations na base real terminado em `ROLLBACK`; aplicação posterior atômica com verificação de preservação de 24.264 reservas, 1.204 pagamentos e 3.094 eventos.
- Dez funções Edge ativas, com JWT das funções existentes preservado; fontes baixadas após a publicação conferidas com o snapshot validado, normalizando apenas BOM e quebras de linha.
- Jobs de expiração e conciliação ativos, com URL correta do projeto. Não foi alterado o segredo interno existente nem a integração de mensalidades.
- Frontend publicado em `dpl_YTo64CEJgdjf7SEijmX8B3aBKNu9`, promovido para [plugguest.com.br](https://plugguest.com.br). Snapshot de 302 arquivos de upload sem credenciais, testes ou backups, com manifesto SHA-256 `4cffb8cff62f287a612727fd8faf9cbcc38696276cb6663eae31b5d957f613f4`.
- HTTP 200 e bundles conferidos: empresa com apenas Regras/Pagamentos/Resumo; superadmin com token e detalhes do webhook. As dez funções passaram nos testes de CORS e rejeição de chamadas inválidas ou sem autorização. A inspeção visual via navegador ficou indisponível; a versão foi validada pelos artefatos e respostas HTTP.
- A conta central ainda precisa ser configurada pelo superadmin. Não foram migrados tokens das quatro configurações antigas, ativadas funcionalidades de empresas ou criadas cobranças/estornos reais.

## Referências oficiais usadas na revisão

- [Criar um webhook](https://docs.asaas.com/reference/criar-novo-webhook)
- [Eventos de cobranças](https://docs.asaas.com/docs/webhook-para-cobrancas)
- [Criar link de pagamento](https://docs.asaas.com/reference/criar-um-link-de-pagamentos)
- [Interpretação de estornos — somente DONE é devolvido](https://docs.asaas.com/docs/estornos)
- [Estorno de parcelamento](https://docs.asaas.com/reference/estornar-parcelamento)
