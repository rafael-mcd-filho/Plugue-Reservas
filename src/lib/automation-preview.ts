import { renderReservationWhatsAppTemplate } from './whatsapp-automations';

export const AUTOMATION_EXAMPLE_VALUES: Record<string, string> = {
  nome: 'Maria',
  pessoas: '4',
  data: '05/12/2026',
  hora: '19:00',
  telefone: '+5511999998888',
  posicao: '3',
  tempo_limite_minutos: '5',
  link_acompanhamento: 'https://exemplo.invalid/reserva/DEMONSTRACAO',
  link_avaliacao: 'https://exemplo.invalid/avaliacao/DEMONSTRACAO',
  avaliacao: 'DEMONSTRACAO',
  dias_sem_visita: '30',
  data_ultima_visita: '05/11/2026',
  link_reserva: 'https://exemplo.invalid/reservar',
};

export function getAutomationPreview(template: string, reviewsAvailable: boolean) {
  return renderReservationWhatsAppTemplate(template, {
    guestName: 'Maria Silva',
    guestPhone: AUTOMATION_EXAMPLE_VALUES.telefone,
    partySize: 4,
    date: '2026-12-05',
    time: '19:00',
    trackingUrl: AUTOMATION_EXAMPLE_VALUES.link_acompanhamento,
    reviewUrl: reviewsAvailable ? AUTOMATION_EXAMPLE_VALUES.link_avaliacao : '',
    daysWithoutVisit: 30,
    lastVisitDate: '2026-11-05',
    reservationUrl: AUTOMATION_EXAMPLE_VALUES.link_reserva,
  }).replace(/\{posicao\}/g, AUTOMATION_EXAMPLE_VALUES.posicao);
}

const DISPATCH_CONDITIONS: Record<string, string> = {
  confirmation_message: 'Próximo envio: quando uma nova reserva gerar a confirmação.',
  cancellation_message: 'Próximo envio: quando uma reserva for cancelada.',
  waitlist_entry: 'Próximo envio: quando um cliente entrar na lista de espera.',
  waitlist_called: 'Próximo envio: quando um cliente for chamado da lista de espera.',
  reminder_24h: 'Próximo envio: para reservas confirmadas do dia seguinte, na janela das 10h às 17h, respeitando ao menos 1 hora após a criação.',
  reminder_1h: 'Próximo envio: para reservas confirmadas de hoje, entre 1 e 5 horas antes, respeitando ao menos 1 hora após a criação.',
  post_visit: 'Próximo envio: para visitas com check-in ou concluídas, na janela das 08h do dia seguinte.',
  no_show_message: 'Próximo envio: para reservas sem comparecimento, na janela das 09h do dia seguinte.',
  birthday_message: 'Próximo envio: para clientes elegíveis, 4 dias antes do aniversário.',
  reactivation_30d: 'Próximo envio: uma vez quando o cliente elegível completar 30 dias sem nova visita.',
};

export function getAutomationDispatchDescription(type: string) {
  const condition = DISPATCH_CONDITIONS[type] ?? 'Próximo envio: quando houver um evento elegível.';
  return `${condition} Depende da ativação salva e do canal configurado. A fila e a cadência podem adiar o envio; esta tela não calcula um horário individual.`;
}
