export const PLATFORM_TERMS_VERSION = '1.0';
export const PLATFORM_TERMS_DATE = '20/11/2026';
export const PLATFORM_TERMS_PATH = '/termos-de-uso';
export const PLATFORM_TERMS_FILENAME = 'termos-de-uso-plug-guest-1.0.txt';

export const PLATFORM_LEGAL_ENTITY = {
  name: 'RW SOLUCOES DIGITAIS LTDA',
  cnpj: '68.963.741/0001-01',
  address: 'Av. Nossa Senhora da Luz, nº 499, Conjunto 02, Andar 01, Bacacheri, Curitiba – PR, CEP 82510-020',
  email: 'contato@rwsolucoesdigitais.com',
} as const;

export const PLATFORM_TERMS_SUMMARY = [
  'O estabelecimento presta o atendimento. A Plug Guest fornece a tecnologia de reservas e os recursos de pagamento disponibilizados no fluxo.',
  'Quando houver sinal, a pré-reserva depende da confirmação do pagamento dentro do prazo informado. O sinal é abatido integralmente do consumo ou serviço correspondente.',
  'Cancelamento, remarcação e reembolso seguem as condições informadas para a reserva e os direitos previstos em lei. Não há perda automática do sinal por estes termos.',
  'Para dúvidas ou problemas, procure os canais do estabelecimento ou o atendimento da Plug Guest. Guarde o código da reserva e os comprovantes.',
] as const;

export interface PlatformTermsSection {
  id: string;
  title: string;
  paragraphs: readonly string[];
}

export const PLATFORM_TERMS_SECTIONS: readonly PlatformTermsSection[] = [
  {
    id: 'responsavel-e-escopo',
    title: 'Quem somos e a quem se aplicam estes termos',
    paragraphs: [
      `A Plug Guest é uma plataforma operada por ${PLATFORM_LEGAL_ENTITY.name}, CNPJ ${PLATFORM_LEGAL_ENTITY.cnpj}, com endereço em ${PLATFORM_LEGAL_ENTITY.address}. O contato eletrônico da plataforma é ${PLATFORM_LEGAL_ENTITY.email}.`,
      'Estes termos se destinam às pessoas que utilizam as páginas públicas para solicitar, pagar ou acompanhar reservas, participar da fila de espera e enviar avaliações. A assinatura do sistema pelos estabelecimentos e as condições comerciais entre eles e a plataforma são tratadas em contratos próprios.',
      'Leia os termos e as condições específicas da oferta antes de concluir uma solicitação ou pagamento. Você pode consultar e salvar uma cópia deste documento sem realizar uma reserva.',
    ],
  },
  {
    id: 'plataforma-e-estabelecimento',
    title: 'O papel da plataforma e do estabelecimento',
    paragraphs: [
      'A Plug Guest disponibiliza a tecnologia de reserva, fila, comunicação e acompanhamento. Quando o módulo de pagamentos estiver habilitado, também disponibiliza a geração e o acompanhamento de cobranças, a conciliação e a administração dos recebimentos e repasses ao estabelecimento, por meio de prestador de pagamentos.',
      'O estabelecimento identificado na oferta define e executa o atendimento: datas, horários, capacidade, serviços, preços e condições específicas. Confira a unidade escolhida e seus canais de contato. As responsabilidades de cada participante seguem sua atuação e a legislação; estes termos não excluem responsabilidades atribuídas à plataforma ou ao estabelecimento por lei.',
    ],
  },
  {
    id: 'dados-e-uso-adequado',
    title: 'Informações da reserva e uso adequado',
    paragraphs: [
      'Informe dados corretos, atualizados e necessários ao atendimento. Confira nome, telefone, unidade, data, horário e quantidade de pessoas, incluindo adultos e crianças conforme a orientação do formulário. Para reservar por outra pessoa, tenha autorização para fornecer os dados e comunicar as condições da reserva.',
      'Solicitações que envolvam obrigações de pagamento devem ser feitas por pessoa com capacidade legal ou com a assistência ou representação exigida em lei. A inclusão de crianças em um grupo não dispensa os cuidados aplicáveis aos seus dados pessoais.',
      'Não utilize a plataforma para reservas fictícias, fraude, uso indevido de dados ou meios de pagamento de terceiros, ataques ou interferência no serviço. Medidas de segurança devem ser proporcionais e não afastam o atendimento de solicitações legítimas nem os direitos relacionados a pagamentos já realizados.',
    ],
  },
  {
    id: 'solicitacao-e-confirmacao',
    title: 'Solicitação, disponibilidade e confirmação',
    paragraphs: [
      'A solicitação deve respeitar a disponibilidade apresentada para o grupo e o horário escolhidos. Confira o resultado exibido e guarde o código ou link de acompanhamento. Uma mensagem de erro ou uma solicitação incompleta não devem ser interpretadas como confirmação.',
      'Se houver cobrança de sinal, a criação da pré-reserva ou do link de pagamento ainda não confirma a reserva. O pagamento precisa ser confirmado pelo serviço dentro do prazo informado. Nas reservas sem cobrança, observe a confirmação apresentada ao concluir a solicitação.',
      'Alterações de data, horário, quantidade ou acomodação dependem de nova verificação. A seleção ou indicação de mesa segue o que tiver sido oferecido para aquela reserva e não substitui condições específicas previamente informadas pelo estabelecimento.',
    ],
  },
  {
    id: 'sinal-e-pagamento',
    title: 'Sinal, valor e meios de pagamento',
    paragraphs: [
      'Quando exigido, o sinal ou pré-pagamento é um adiantamento do preço do consumo ou serviço correspondente e deve ser integralmente abatido pelo estabelecimento. Por exemplo: um sinal de R$ 100,00 gera R$ 100,00 de abatimento, mesmo que o repasse líquido ao estabelecimento seja menor por custos da relação comercial com a plataforma.',
      'Se o valor final do consumo ou serviço for menor que o sinal, o saldo não utilizado deverá ser devolvido, salvo destinação alternativa específica, válida e livremente aceita por você.',
      'Valor, forma de cálculo, meios aceitos e prazo dependem da oferta. A cobrança pode ser por reserva ou por pessoa e pode apresentar valores diferentes conforme o método. Antes de pagar, confira o valor final do método escolhido, o que ele cobre e as condições da reserva. Os métodos disponibilizados podem incluir Pix e cartão de crédito à vista, em parcela única.',
      'Utilize os meios apresentados no fluxo oficial. A confirmação depende do status verificado pelo serviço de pagamentos; envio de comprovante, autorização inicial de cartão ou retorno à página não equivalem, por si, a pagamento confirmado. Em caso de divergência ou cobrança duplicada, solicite conferência pelos canais de atendimento e guarde os comprovantes.',
      'O abatimento é realizado pelo estabelecimento no atendimento. A plataforma não presume integração automática com comanda, caixa ou sistema fiscal. O sinal não se torna, apenas por esse nome, taxa não reembolsável, consumo mínimo, penalidade ou crédito futuro obrigatório.',
    ],
  },
  {
    id: 'prazo-e-pagamento-tardio',
    title: 'Prazo, expiração e pagamento fora do prazo',
    paragraphs: [
      'Observe o prazo ou contador exibido para pagamento. Uma pré-reserva expirada pode ter sua disponibilidade liberada. Não efetue um novo pagamento sem conferir a situação da cobrança anterior quando houver dúvida sobre o resultado.',
      'Pagamento identificado depois da expiração, do cancelamento ou de outra perda de validade exige conferência pela equipe. Ele não restabelece automaticamente a reserva. A equipe deverá verificar a disponibilidade e encaminhar a solução cabível, inclusive devolução quando devida; a falta de confirmação não autoriza reter o valor sem fundamento.',
    ],
  },
  {
    id: 'cancelamento-remarcacao-e-falta',
    title: 'Cancelamento, remarcação e não comparecimento',
    paragraphs: [
      'As condições específicas de cancelamento, remarcação, tolerância de atraso e não comparecimento devem ser informadas antes da contratação e do pagamento. Elas complementam estes termos sem afastar direitos legais. Na ausência de condição válida e previamente informada, não se presume autorização para reter o sinal.',
      'Utilize o acompanhamento da reserva para as ações que estiverem disponíveis. Quando houver pagamento recebido ou a alteração depender de atendimento, solicite a providência pelo canal do estabelecimento apresentado no acompanhamento. Você também pode contatar a plataforma pelo e-mail indicado nestes termos, informando unidade, código, data e a providência desejada.',
      'Cancelar uma reserva e devolver um pagamento são providências diferentes no processamento. Quando o cancelamento ou o arrependimento gerar direito à devolução, ela deverá ser encaminhada sem exigir um pedido adicional do consumidor. Acompanhe o resultado pelos canais de atendimento. O não comparecimento não causa perda automática do sinal por força destes termos.',
      'Se o estabelecimento cancelar ou não puder cumprir a oferta, devem ser respeitadas as alternativas e devoluções asseguradas ao consumidor. Uma solução alternativa ou crédito futuro não pode ser imposto em substituição a um reembolso legalmente devido.',
    ],
  },
  {
    id: 'arrependimento-e-devolucao',
    title: 'Direitos do consumidor e devoluções',
    paragraphs: [
      'São preservados os direitos do Código de Defesa do Consumidor, inclusive o direito de arrependimento nas contratações à distância em que seja aplicável, no prazo legal de sete dias previsto no art. 49. Solicite seu exercício pelos canais de atendimento informados, sem necessidade de aceitar uma política que reduza esse direito.',
      'O pedido de devolução deve ser registrado e acompanhado até a conclusão. O recebimento de uma solicitação ou a indicação de estorno em processamento não significa que o crédito já foi efetivado. O andamento depende do meio de pagamento e das providências do prestador, sem afastar prazos e obrigações legais.',
      'Quando a devolução integral for devida, comissões da relação entre plataforma e estabelecimento não reduzem o valor a restituir ao consumidor. Qualquer restituição parcial ou retenção deve ter fundamento válido e ser explicada. Não solicite nem envie senhas, códigos de segurança ou números completos de cartão por mensagens para tratar um estorno.',
    ],
  },
  {
    id: 'fila-mensagens-e-acompanhamento',
    title: 'Fila de espera, mensagens e acompanhamento',
    paragraphs: [
      'Participar da fila de espera não equivale a ter uma reserva confirmada. A posição corresponde ao critério informado na fila; estimativas de espera não garantem um horário exato de atendimento. Observe as instruções de chamada e apresentação disponibilizadas pela unidade.',
      'Mensagens sobre reserva, pagamento, chamada ou atendimento podem ser encaminhadas aos contatos informados. A recepção de uma mensagem pode depender da conexão e do canal utilizado; acompanhe também o estado no link oficial e procure a equipe se houver divergência.',
      'Proteja o código e o link de acompanhamento, pois permitem consultar informações e, quando disponível, realizar ações sobre a reserva. Não os publique ou compartilhe com pessoas que não devam ter acesso.',
    ],
  },
  {
    id: 'dados-pessoais',
    title: 'Dados pessoais e comunicações promocionais',
    paragraphs: [
      'Os dados fornecidos são utilizados, conforme a finalidade e a base legal pertinentes, para organizar a reserva ou fila, processar e conciliar pagamentos, prestar atendimento, prevenir fraude e cumprir obrigações legais. O estabelecimento recebe as informações necessárias ao atendimento, e prestadores de tecnologia, comunicação e pagamento podem participar dessas operações.',
      'Você pode solicitar informações sobre o tratamento, acesso, correção e os demais direitos previstos na LGPD, inclusive eliminação ou revogação de consentimento quando cabíveis, pelo contato da plataforma ou do estabelecimento. A conservação necessária ao cumprimento de obrigações legais e ao exercício regular de direitos será considerada na resposta.',
      'Aceitar estes termos não constitui autorização genérica para publicidade, perfilamento ou tecnologias de rastreamento. Finalidades adicionais devem ter informação e fundamento próprios; quando dependerem de consentimento, a escolha deve ser específica e separada. Para informações adicionais sobre o tratamento de seus dados, utilize os canais de contato indicados neste documento.',
    ],
  },
  {
    id: 'disponibilidade-e-avaliacoes',
    title: 'Funcionamento do serviço e avaliações',
    paragraphs: [
      'O serviço pode passar por manutenção ou falhas de conexão e de integrações. Havendo problema, não repita pagamentos indiscriminadamente; conserve o código e procure atendimento. Falhas técnicas não afastam os direitos relativos a reservas ou pagamentos já realizados.',
      'Se enviar uma avaliação, relate sua experiência com respeito e sem divulgar dados de terceiros ou conteúdo ilícito. Eventual moderação deve respeitar a legislação e não elimina o direito de reclamar ou de buscar os canais de defesa do consumidor.',
    ],
  },
  {
    id: 'atendimento-e-solucao',
    title: 'Atendimento e solução de problemas',
    paragraphs: [
      `Para questões do atendimento presencial, procure os contatos da unidade na oferta ou no acompanhamento. Para dúvidas sobre a plataforma, reserva, cobrança ou exercício de direitos, escreva para ${PLATFORM_LEGAL_ENTITY.email}. Informe apenas os dados necessários à localização do caso, como unidade, código, data e descrição do problema.`,
      'O atendimento deve observar os deveres e prazos legais aplicáveis. Você pode utilizar os órgãos de defesa do consumidor e as vias administrativas e judiciais competentes, sem obrigação de arbitragem ou de tentar exclusivamente um canal privado. Não se impõe foro que restrinja seus direitos como consumidor.',
    ],
  },
  {
    id: 'versao-e-condicoes',
    title: 'Versão e condições aplicáveis',
    paragraphs: [
      'A versão e a data de elaboração identificadas neste documento permitem conservar o texto consultado. Para uma reserva, devem ser consideradas as condições apresentadas na contratação e os direitos previstos em lei. Mudanças futuras não podem modificar retroativamente as condições de uma reserva já contratada ou reduzir direitos assegurados.',
      'Em caso de conflito, prevalecem as normas obrigatórias e os direitos do consumidor; condições específicas da oferta somente complementam estes termos quando forem válidas e previamente informadas. A invalidade de uma disposição não impede a aplicação das demais que forem compatíveis com a lei.',
    ],
  },
];

export function getPlatformTermsText(companyName?: string) {
  return [
    'Termos de Uso da Plug Guest',
    `Versão ${PLATFORM_TERMS_VERSION} · Elaborada em ${PLATFORM_TERMS_DATE}`,
    ...(companyName ? [`Estabelecimento desta reserva: ${companyName}. Confira também as condições específicas da oferta.`] : []),
    'Resumo',
    ...PLATFORM_TERMS_SUMMARY.map((item) => `• ${item}`),
    ...PLATFORM_TERMS_SECTIONS.flatMap((section, index) => [
      `${index + 1}. ${section.title}`,
      ...section.paragraphs,
    ]),
  ].join('\n\n');
}
