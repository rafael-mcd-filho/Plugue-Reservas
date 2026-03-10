import { useState, useEffect } from 'react';
import { Bot, MessageCircle, Clock, Save, PartyPopper, Ban, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { useAutomationSettings, useUpsertAutomation } from '@/hooks/useAutomations';
import WhatsAppConnection from './WhatsAppConnection';
import WhatsAppMessageHistory from './WhatsAppMessageHistory';

interface Props {
  companyId: string;
}

const AUTOMATION_TYPES = [
  {
    type: 'confirmation_message',
    label: 'Mensagem de Confirmação',
    description: 'Enviada automaticamente quando uma reserva é criada',
    icon: MessageCircle,
    defaultTemplate: 'Olá {nome}! Sua reserva para {pessoas} pessoa(s) no dia {data} às {hora} foi confirmada. Até lá! 🎉',
  },
  {
    type: 'reminder_24h',
    label: 'Lembrete 24h Antes',
    description: 'Enviado automaticamente 24 horas antes do horário da reserva',
    icon: Clock,
    defaultTemplate: 'Olá {nome}! Lembrete: sua reserva é amanhã, dia {data} às {hora}, para {pessoas} pessoa(s). Esperamos você! 📅',
  },
  {
    type: 'reminder_1h',
    label: 'Lembrete 1h Antes',
    description: 'Enviado automaticamente 1 hora antes do horário da reserva',
    icon: Clock,
    defaultTemplate: 'Olá {nome}! Lembrete: sua reserva é hoje às {hora} para {pessoas} pessoa(s). Estamos esperando você! 😊',
  },
  {
    type: 'cancellation_message',
    label: 'Notificação de Cancelamento',
    description: 'Enviada quando uma reserva é cancelada (pelo cliente ou restaurante)',
    icon: Ban,
    defaultTemplate: 'Olá {nome}, sua reserva do dia {data} às {hora} foi cancelada. Caso queira reagendar, acesse nosso link de reservas. 🙏',
  },
  {
    type: 'post_visit',
    label: 'Mensagem Pós-Visita',
    description: 'Enviada automaticamente após o horário da reserva (agradecimento)',
    icon: Star,
    defaultTemplate: 'Olá {nome}! Obrigado pela visita! Esperamos que tenha gostado. Nos vemos em breve! ⭐',
  },
  {
    type: 'birthday_message',
    label: 'Mensagem de Aniversário',
    description: 'Enviada no dia do aniversário do cliente (baseado na data de nascimento)',
    icon: PartyPopper,
    defaultTemplate: 'Parabéns, {nome}! 🎂🎉 Desejamos um feliz aniversário! Que tal comemorar conosco? Faça sua reserva!',
  },
  {
    type: 'waitlist_entry',
    label: 'Entrada na Lista de Espera',
    description: 'Enviada quando o cliente é adicionado à lista de espera, com link de acompanhamento',
    icon: Clock,
    defaultTemplate: 'Olá {nome}! Você está na posição {posicao} da lista de espera ({pessoas} pessoa(s)).\n\n📋 Acompanhe em tempo real:\n{link_acompanhamento}',
  },
  {
    type: 'waitlist_called',
    label: 'Chamada da Lista de Espera',
    description: 'Enviada quando o cliente é chamado da lista de espera',
    icon: MessageCircle,
    defaultTemplate: '🔔 {nome}, sua mesa está pronta! Dirija-se à recepção. Você tem 10 minutos para se apresentar.',
  },
];

export default function AutomationsTab({ companyId }: Props) {
  const { data: automations = [], isLoading } = useAutomationSettings(companyId);
  const upsertAutomation = useUpsertAutomation();
  const [localState, setLocalState] = useState<Record<string, { enabled: boolean; message_template: string }>>({});
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (automations.length >= 0 && !initialized) {
      const state: Record<string, { enabled: boolean; message_template: string }> = {};
      for (const at of AUTOMATION_TYPES) {
        const existing = automations.find(a => a.type === at.type);
        state[at.type] = {
          enabled: existing?.enabled ?? false,
          message_template: existing?.message_template || at.defaultTemplate,
        };
      }
      setLocalState(state);
      setInitialized(true);
    }
  }, [automations, initialized]);

  const handleSave = async (type: string) => {
    const s = localState[type];
    if (!s) return;
    await upsertAutomation.mutateAsync({
      company_id: companyId,
      type,
      enabled: s.enabled,
      message_template: s.message_template,
    });
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" /></div>;
  }

  return (
    <div className="space-y-6">
      <WhatsAppConnection companyId={companyId} />

      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" /> Mensagens Automáticas
          </h3>
          <p className="text-sm text-muted-foreground">Configure mensagens enviadas automaticamente via WhatsApp</p>
        </div>

        <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">
          <strong>Variáveis disponíveis:</strong>{' '}
          <code className="text-primary">{'{nome}'}</code>,{' '}
          <code className="text-primary">{'{pessoas}'}</code>,{' '}
          <code className="text-primary">{'{data}'}</code>,{' '}
          <code className="text-primary">{'{hora}'}</code>,{' '}
          <code className="text-primary">{'{telefone}'}</code>
        </div>

        {AUTOMATION_TYPES.map(at => {
          const state = localState[at.type];
          if (!state) return null;
          const Icon = at.icon;

          return (
            <Card key={at.type} className="border border-border shadow-sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Icon className="h-5 w-5 text-primary" /> {at.label}
                  </CardTitle>
                  <Switch
                    checked={state.enabled}
                    onCheckedChange={(checked) =>
                      setLocalState(prev => ({ ...prev, [at.type]: { ...prev[at.type], enabled: checked } }))
                    }
                  />
                </div>
                <CardDescription>{at.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label>Modelo da mensagem</Label>
                  <Textarea
                    value={state.message_template}
                    onChange={e => setLocalState(prev => ({
                      ...prev,
                      [at.type]: { ...prev[at.type], message_template: e.target.value }
                    }))}
                    rows={3}
                    placeholder="Digite o modelo da mensagem..."
                  />
                </div>
                <Button
                  onClick={() => handleSave(at.type)}
                  disabled={upsertAutomation.isPending}
                  size="sm"
                  className="gap-2"
                >
                  <Save className="h-4 w-4" /> Salvar
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <WhatsAppMessageHistory companyId={companyId} />
    </div>
  );
}
