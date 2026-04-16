import { Ban, Clock, MessageCircle, PartyPopper, Star, type LucideIcon } from 'lucide-react';

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
    label: 'Lembrete 24h Antes',
    description: 'Enviado automaticamente 24 horas antes do horário da reserva',
    icon: Clock,
    defaultTemplate: 'Olá, {nome}! ⏰ Passando para lembrar da sua reserva amanhã, dia {data} às {hora}, para {pessoas} pessoa(s). Vai ser um prazer te receber! 🍽️',
    variables: ['nome', 'pessoas', 'data', 'hora', 'telefone'],
  },
  {
    type: 'reminder_1h',
    label: 'Lembrete 1h Antes',
    description: 'Enviado automaticamente 1 hora antes do horário da reserva',
    icon: Clock,
    defaultTemplate: 'Olá, {nome}! ⏳ Falta pouco: sua reserva é hoje às {hora} para {pessoas} pessoa(s). Estamos te esperando! 🍽️',
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
    description: 'Enviada automaticamente às 08:00 do dia seguinte para reservas com check-in concluído',
    icon: Star,
    defaultTemplate: 'Olá, {nome}! ✨ Obrigado pela visita. Esperamos que você tenha aproveitado a experiência. Volte sempre! 💛',
    variables: ['nome', 'pessoas', 'data', 'hora', 'telefone'],
  },
  {
    type: 'birthday_message',
    label: 'Mensagem de Aniversário',
    description: 'Enviada no dia do aniversário do cliente',
    icon: PartyPopper,
    defaultTemplate: 'Parabéns, {nome}! 🎉 Desejamos um aniversário incrível, cheio de alegria e bons momentos. Quando quiser comemorar com a gente, vai ser um prazer te receber! 🥂',
    variables: ['nome'],
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

export const WHATSAPP_MESSAGE_TYPE_LABELS: Record<string, string> = {
  confirmation: 'Confirmação',
  cancellation: 'Cancelamento',
  reminder_1h: 'Lembrete 1h',
  reminder_24h: 'Lembrete 24h',
  post_visit: 'Pós-visita',
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
