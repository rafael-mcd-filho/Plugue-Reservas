import { Ban, Clock, MessageCircle, PartyPopper, Star, UserX, type LucideIcon } from 'lucide-react';

export interface PlugueChatAutomationDefinition {
  type: string;
  label: string;
  description: string;
  icon: LucideIcon;
  parameters: string[];
}

export const PLUGUECHAT_AUTOMATIONS: PlugueChatAutomationDefinition[] = [
  {
    type: 'confirmation_message',
    label: 'Confirmação de Reserva',
    description: 'Enviada automaticamente quando uma reserva é criada.',
    icon: MessageCircle,
    parameters: ['nome', 'pessoas', 'data', 'hora', 'link_acompanhamento'],
  },
  {
    type: 'cancellation_message',
    label: 'Cancelamento de Reserva',
    description: 'Enviada quando uma reserva é cancelada.',
    icon: Ban,
    parameters: ['nome', 'data', 'hora', 'link_acompanhamento'],
  },
  {
    type: 'reminder_24h',
    label: 'Lembrete 24h',
    description: 'Enviado no dia anterior à reserva.',
    icon: Clock,
    parameters: ['nome', 'data', 'hora', 'pessoas'],
  },
  {
    type: 'reminder_1h',
    label: 'Lembrete 1h',
    description: 'Enviado algumas horas antes da reserva.',
    icon: Clock,
    parameters: ['nome', 'hora', 'pessoas'],
  },
  {
    type: 'waitlist_entry',
    label: 'Entrada na Lista de Espera',
    description: 'Enviada quando o cliente entra na lista de espera.',
    icon: Clock,
    parameters: ['nome', 'pessoas', 'posicao', 'link_acompanhamento'],
  },
  {
    type: 'waitlist_called',
    label: 'Chamada da Lista de Espera',
    description: 'Enviada quando o cliente é chamado.',
    icon: MessageCircle,
    parameters: ['nome', 'tempo_limite_minutos'],
  },
  {
    type: 'post_visit',
    label: 'Pós-visita',
    description: 'Enviada no dia seguinte à visita.',
    icon: Star,
    parameters: ['nome', 'data'],
  },
  {
    type: 'no_show_message',
    label: 'No-show',
    description: 'Enviada quando o cliente não compareceu à reserva.',
    icon: UserX,
    parameters: ['nome', 'data', 'hora'],
  },
  {
    type: 'birthday_message',
    label: 'Aniversário',
    description: 'Enviada 4 dias antes do aniversário do cliente.',
    icon: PartyPopper,
    parameters: ['nome'],
  },
];

export const PLUGUECHAT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  PLUGUECHAT_AUTOMATIONS.map((a) => [a.type, a.label]),
);

export const PLUGUECHAT_PARAMETER_MAP: Record<string, string[]> = Object.fromEntries(
  PLUGUECHAT_AUTOMATIONS.map((a) => [a.type, a.parameters]),
);
