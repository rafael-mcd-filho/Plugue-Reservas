import { useEffect, useState } from 'react';
import { Bot, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import WhatsAppConnection from './WhatsAppConnection';
import WhatsAppMessageHistory from './WhatsAppMessageHistory';
import { type AutomationSetting, useAutomationSettings, useUpsertAutomation } from '@/hooks/useAutomations';
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
  const { data: automations, isLoading } = useAutomationSettings(companyId);
  const upsertAutomation = useUpsertAutomation();
  const [localState, setLocalState] = useState<AutomationLocalState>({});
  const [hydratedCompanyId, setHydratedCompanyId] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading || hydratedCompanyId === companyId) return;

    setLocalState(buildAutomationState(automations));
    setHydratedCompanyId(companyId);
  }, [automations, companyId, hydratedCompanyId, isLoading]);

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
    setLocalState((prev) => ({
      ...prev,
      [type]: nextState,
    }));

    try {
      await handleSave(type, nextState);
    } catch {
      setLocalState((prev) => ({
        ...prev,
        [type]: currentState,
      }));
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <WhatsAppConnection companyId={companyId} />

      <div className="space-y-4">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Bot className="h-5 w-5 text-primary" /> Mensagens automáticas
          </h3>
          <p className="text-sm text-muted-foreground">
            Confirmação, cancelamento e fila disparam por evento. Lembretes, pós-visita e aniversário dependem dos jobs automáticos.
          </p>
        </div>

        {WHATSAPP_AUTOMATIONS.map((automation) => {
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
        })}
      </div>

      <WhatsAppMessageHistory companyId={companyId} />
    </div>
  );
}
