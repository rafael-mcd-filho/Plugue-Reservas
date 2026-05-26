import { useEffect, useState } from 'react';
import { Bot, History, Radio, Save, Send, Smartphone } from 'lucide-react';
import PlugueChatMessageHistory from './PlugueChatMessageHistory';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import BroadcastsTab from './BroadcastsTab';
import ChannelTab from './ChannelTab';
import PlugueChatBroadcastsTab from './PlugueChatBroadcastsTab';
import PlugueChatConnection from './PlugueChatConnection';
import PlugueChatMessages from './PlugueChatMessages';
import WhatsAppConnection from './WhatsAppConnection';
import WhatsAppMessageHistory from './WhatsAppMessageHistory';
import { type AutomationSetting, useAutomationSettings, useUpsertAutomation } from '@/hooks/useAutomations';
import { useWhatsAppChannel } from '@/hooks/useWhatsAppChannel';
import { WHATSAPP_AUTOMATIONS } from '@/lib/whatsapp-automations';

interface Props {
  companyId: string;
}

type AutomationLocalState = Record<string, { enabled: boolean; message_template: string }>;

function buildAutomationState(automations: AutomationSetting[] | undefined): AutomationLocalState {
  const nextState: AutomationLocalState = {};

  for (const automation of WHATSAPP_AUTOMATIONS) {
    const existing = automations?.find((item) => item.type === automation.type);
    nextState[automation.type] = {
      enabled: existing?.enabled ?? false,
      message_template: existing?.message_template || automation.defaultTemplate,
    };
  }

  return nextState;
}

export default function AutomationsTab({ companyId }: Props) {
  const { data: channel } = useWhatsAppChannel(companyId);
  const isPlugueChat = channel === 'pluguechat_official';

  const { data: automations, isLoading: automationsLoading } = useAutomationSettings(companyId);
  const upsertAutomation = useUpsertAutomation();
  const [localState, setLocalState] = useState<AutomationLocalState>({});
  const [hydratedCompanyId, setHydratedCompanyId] = useState<string | null>(null);

  useEffect(() => {
    if (automationsLoading || hydratedCompanyId === companyId) return;

    setLocalState(buildAutomationState(automations));
    setHydratedCompanyId(companyId);
  }, [automations, companyId, hydratedCompanyId, automationsLoading]);

  const handleSave = async (
    type: string,
    state: { enabled: boolean; message_template: string } | undefined = localState[type],
  ) => {
    if (!state) return;

    await upsertAutomation.mutateAsync({
      company_id: companyId,
      type,
      enabled: state.enabled,
      message_template: state.message_template,
    });
  };

  const handleToggle = async (type: string, checked: boolean) => {
    const currentState = localState[type];
    if (!currentState) return;

    const nextState = { ...currentState, enabled: checked };
    setLocalState((prev) => ({ ...prev, [type]: nextState }));

    try {
      await handleSave(type, nextState);
    } catch {
      setLocalState((prev) => ({ ...prev, [type]: currentState }));
    }
  };

  return (
    <Tabs defaultValue="channel" className="space-y-6">
      <TabsList className="w-full grid grid-cols-5">
        <TabsTrigger value="channel" className="gap-2">
          <Radio className="h-4 w-4 max-sm:hidden" /> Canal
        </TabsTrigger>
        <TabsTrigger value="connection" className="gap-2">
          <Smartphone className="h-4 w-4 max-sm:hidden" /> Conexão
        </TabsTrigger>
        <TabsTrigger value="messages" className="gap-2">
          <Bot className="h-4 w-4 max-sm:hidden" /> Mensagens
        </TabsTrigger>
        <TabsTrigger value="broadcast" className="gap-2">
          <Send className="h-4 w-4 max-sm:hidden" /> Disparo
        </TabsTrigger>
        <TabsTrigger value="history" className="gap-2">
          <History className="h-4 w-4 max-sm:hidden" /> Histórico
        </TabsTrigger>
      </TabsList>

      <TabsContent value="channel">
        <ChannelTab companyId={companyId} activeChannel={channel ?? 'evolution'} />
      </TabsContent>

      <TabsContent value="connection">
        {isPlugueChat ? (
          <PlugueChatConnection companyId={companyId} activeChannel={channel!} />
        ) : (
          <WhatsAppConnection companyId={companyId} />
        )}
      </TabsContent>

      <TabsContent value="messages" className="space-y-4">
        {isPlugueChat ? (
          <PlugueChatMessages companyId={companyId} activeChannel={channel!} />
        ) : (
          <>
            <div>
              <h3 className="flex items-center gap-2 text-lg font-semibold">
                <Bot className="h-5 w-5 text-primary" /> Mensagens automáticas
              </h3>
              <p className="text-sm text-muted-foreground">
                Confirmação, cancelamento e fila disparam por evento. Lembretes, pós-visita, aniversário e no-show usam fila com cadência controlada.
              </p>
            </div>

            {automationsLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              WHATSAPP_AUTOMATIONS.map((automation) => {
                const state = localState[automation.type];
                if (!state) return null;

                const Icon = automation.icon;

                return (
                  <Card key={automation.type} className="border border-border shadow-sm">
                    <CardHeader className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <Icon className="h-5 w-5 text-primary" /> {automation.label}
                          </CardTitle>
                          <CardDescription>{automation.description}</CardDescription>
                        </div>
                        <Switch
                          checked={state.enabled}
                          disabled={upsertAutomation.isPending}
                          onCheckedChange={(checked) => void handleToggle(automation.type, checked)}
                        />
                      </div>

                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {automation.variables.map((variable) => (
                          <span key={variable} className="rounded-full bg-muted px-2.5 py-1 font-medium">
                            {'{'}
                            {variable}
                            {'}'}
                          </span>
                        ))}
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3">
                      <div className="space-y-2">
                        <Label>Modelo da mensagem</Label>
                        <Textarea
                          value={state.message_template}
                          onChange={(event) =>
                            setLocalState((prev) => ({
                              ...prev,
                              [automation.type]: {
                                ...prev[automation.type],
                                message_template: event.target.value,
                              },
                            }))
                          }
                          rows={4}
                          placeholder="Digite o modelo da mensagem..."
                        />
                      </div>

                      <Button
                        onClick={() => handleSave(automation.type)}
                        disabled={upsertAutomation.isPending}
                        size="sm"
                        className="gap-2"
                      >
                        <Save className="h-4 w-4" /> Salvar
                      </Button>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </>
        )}
      </TabsContent>

      <TabsContent value="broadcast">
        {isPlugueChat ? (
          <PlugueChatBroadcastsTab companyId={companyId} activeChannel={channel!} />
        ) : (
          <BroadcastsTab companyId={companyId} />
        )}
      </TabsContent>

      <TabsContent value="history">
        {isPlugueChat ? (
          <PlugueChatMessageHistory companyId={companyId} />
        ) : (
          <WhatsAppMessageHistory companyId={companyId} />
        )}
      </TabsContent>
    </Tabs>
  );
}
