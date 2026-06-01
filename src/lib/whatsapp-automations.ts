import { Ban, Clock, MessageCircle, PartyPopper, Star, UserX, type LucideIcon } from 'lucide-react';

export interface WhatsAppAutomationDefinition {
  type: string;
  label: string;
  description: string;
  icon: LucideIcon;
  defaultTemplate: string;
  variables: string[];
}

export interface ParsedWhatsAppErrorDetails {
  code: string | null;
  title: string;
  message: string;
  providerStatus: number | null;
  providerMessage: string | null;
  raw: string | null;
}

export const WHATSAPP_AUTOMATIONS: WhatsAppAutomationDefinition[] = [
  {
    type: 'confirmation_message',
    label: 'Mensagem de Confirmação',
    description: 'Enviada automaticamente quando uma reserva é criada',
    icon: MessageCircle,
    defaultTemplate: 'Olá, {nome}! ✨ Sua reserva para {pessoas} pessoa(s) no dia {data} às {hora} está confirmada.\n\nAcompanhe sua reserva por aqui 👇\n{link_acompanhamento}',
    variables: ['nome', 'pessoas', 'data', 'hora', 'telefone', 'link_acompanhamento'],
  },
  {
    type: 'reminder_24h',
    label: 'Lembrete do Dia Anterior',
    description: 'Enviado no dia anterior durante o dia, com cadencia controlada',
    icon: Clock,
    defaultTemplate: 'Ola, {nome}! Passando para lembrar que voce tem uma reserva amanha, dia {data}, as {hora}, para {pessoas} pessoa(s). Vai ser um prazer te receber!',
    variables: ['nome', 'pessoas', 'data', 'hora', 'telefone'],
  },
  {
    type: 'reminder_1h',
    label: 'Lembrete de Logo Mais',
    description: 'Enviado algumas horas antes da reserva, nunca com menos de 1 hora de antecedencia',
    icon: Clock,
    defaultTemplate: 'Ola, {nome}! Passando para lembrar que hoje voce tem uma reserva as {hora}, para {pessoas} pessoa(s). Esperamos voce!',
    variables: ['nome', 'pessoas', 'data', 'hora', 'telefone'],
  },
  {
    type: 'cancellation_message',
    label: 'Notificação de Cancelamento',
    description: 'Enviada quando uma reserva é cancelada',
    icon: Ban,
    defaultTemplate: 'Olá, {nome}. Sua reserva do dia {data} às {hora} foi cancelada.\n\nSe quiser acompanhar ou fazer uma nova reserva, acesse por aqui 👇\n{link_acompanhamento}',
    variables: ['nome', 'pessoas', 'data', 'hora', 'telefone', 'link_acompanhamento'],
  },
  {
    type: 'post_visit',
    label: 'Mensagem Pós-Visita',
    description: 'Enfileirada às 08:00 do dia seguinte para reservas com check-in concluído, com cadência controlada',
    icon: Star,
    defaultTemplate: 'Olá, {nome}! ✨ Obrigado pela visita. Esperamos que você tenha aproveitado a experiência. Volte sempre! 💛',
    variables: ['nome', 'pessoas', 'data', 'hora', 'telefone'],
  },
  {
    type: 'birthday_message',
    label: 'Mensagem de Aniversário',
    description: 'Enfileirada 4 dias antes do aniversário do cliente, com cadência controlada',
    icon: PartyPopper,
    defaultTemplate: 'Oi, {nome}! 🎉 Seu aniversário está chegando e faltam só 4 dias para essa data especial. Quando quiser comemorar com a gente, vai ser um prazer te receber! 🥂',
    variables: ['nome'],
  },
  {
    type: 'no_show_message',
    label: 'Mensagem de No-Show',
    description: 'Enfileirada às 09:00 do dia seguinte para reservas que não compareceram, com cadência controlada',
    icon: UserX,
    defaultTemplate: 'Olá, {nome}! Notamos que você tinha uma reserva no dia {data} às {hora} e não pôde comparecer.\n\nSentimos sua falta! Se quiser agendar uma nova visita, estamos à disposição. 😊',
    variables: ['nome', 'pessoas', 'data', 'hora', 'telefone'],
  },
  {
    type: 'waitlist_entry',
    label: 'Entrada na Lista de Espera',
    description: 'Enviada quando o cliente é adicionado à lista de espera',
    icon: Clock,
    defaultTemplate: 'Olá, {nome}! ⏳ Você entrou na nossa lista de espera para {pessoas} pessoa(s).\nNo momento, sua posição é {posicao}.\n\nAcompanhe em tempo real por aqui 👇\n{link_acompanhamento}',
    variables: ['nome', 'pessoas', 'posicao', 'telefone', 'link_acompanhamento'],
  },
  {
    type: 'waitlist_called',
    label: 'Chamada da Lista de Espera',
    description: 'Enviada quando o cliente é chamado da lista de espera',
    icon: MessageCircle,
    defaultTemplate: '{nome}, sua mesa está pronta! 🔔 Dirija-se à recepção. Você tem 5 minutos para se apresentar.',
    variables: ['nome', 'pessoas', 'telefone'],
  },
];

const RESERVATION_WHATSAPP_AUTOMATION_TYPES = new Set([
  'confirmation_message',
  'reminder_24h',
  'reminder_1h',
  'cancellation_message',
  'post_visit',
  'birthday_message',
  'no_show_message',
]);

export const RESERVATION_WHATSAPP_AUTOMATIONS = WHATSAPP_AUTOMATIONS.filter((automation) =>
  RESERVATION_WHATSAPP_AUTOMATION_TYPES.has(automation.type),
);

export interface ReservationWhatsAppTemplateContext {
  guestName?: string | null;
  guestPhone?: string | null;
  date?: string | null;
  time?: string | null;
  partySize?: number | null;
  trackingUrl?: string | null;
}

function formatReservationDate(value: string | null | undefined) {
  const [year, month, day] = (value ?? '').split('-');
  return day && month && year ? `${day}/${month}/${year}` : value ?? '';
}

function formatReservationTime(value: string | null | undefined) {
  const [hours, minutes] = (value ?? '').split(':');
  return hours && minutes ? `${hours}:${minutes}` : value ?? '';
}

export function renderReservationWhatsAppTemplate(
  template: string,
  context: ReservationWhatsAppTemplateContext,
) {
  return template
    .replace(/\{nome\}/g, context.guestName ?? '')
    .replace(/\{pessoas\}/g, String(context.partySize ?? 1))
    .replace(/\{data\}/g, formatReservationDate(context.date))
    .replace(/\{hora\}/g, formatReservationTime(context.time))
    .replace(/\{link_acompanhamento\}/g, context.trackingUrl ?? '')
    .replace(/\{telefone\}/g, context.guestPhone ?? '');
}

export const WHATSAPP_MESSAGE_TYPE_LABELS: Record<string, string> = {
  confirmation: 'Confirmação',
  cancellation: 'Cancelamento',
  reminder_1h: 'Lembrete logo mais',
  reminder_24h: 'Lembrete dia anterior',
  post_visit: 'Pós-visita',
  no_show: 'No-show',
  birthday: 'Aniversário',
  waitlist_entry: 'Fila - Entrada',
  waitlist_called: 'Fila - Chamado',
};

const ERROR_TITLE_BY_CODE: Record<string, string> = {
  evolution_not_configured: 'Evolution API não configurada',
  instance_not_configured: 'Instância não configurada',
  instance_disconnected: 'Instância desconectada',
  invalid_payload: 'Dados inválidos para envio',
  provider_request_failed: 'Falha ao enviar mensagem',
  provider_invalid_response: 'Resposta inválida da Evolution API',
  unknown_error: 'Falha inesperada no envio',
};

function detectFallbackErrorCode(text: string) {
  const lowered = text.toLowerCase();

  if (lowered.includes('evolution')) return 'evolution_not_configured';
  if (lowered.includes('desconect') || lowered.includes('not connected') || lowered.includes('closed')) {
    return 'instance_disconnected';
  }
  if (lowered.includes('instância') || lowered.includes('instancia')) return 'instance_not_configured';
  if (lowered.includes('payload')) return 'invalid_payload';
  if (lowered.includes('resposta inválida') || lowered.includes('invalid response')) return 'provider_invalid_response';
  return 'unknown_error';
}

export function parseWhatsAppErrorDetails(value: string | null | undefined): ParsedWhatsAppErrorDetails | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const code = typeof parsed.code === 'string' ? parsed.code : null;
    const title = typeof parsed.title === 'string' ? parsed.title : null;
    const message =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : null;
    const providerMessage =
      typeof parsed.provider_message === 'string'
        ? parsed.provider_message
        : typeof parsed.details === 'string'
          ? parsed.details
          : null;
    const raw = typeof parsed.raw === 'string' ? parsed.raw : value;
    const providerStatus = typeof parsed.provider_status === 'number' ? parsed.provider_status : null;

    return {
      code,
      title: title ?? (code ? ERROR_TITLE_BY_CODE[code] ?? 'Falha no envio' : 'Falha no envio'),
      message: message ?? providerMessage ?? 'Não foi possível enviar a mensagem.',
      providerStatus,
      providerMessage,
      raw,
    };
  } catch {
    const code = detectFallbackErrorCode(value);
    return {
      code,
      title: ERROR_TITLE_BY_CODE[code] ?? 'Falha no envio',
      message: value,
      providerStatus: null,
      providerMessage: null,
      raw: value,
    };
  }
}
