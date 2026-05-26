import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { type PlugueChatTemplate, usePlugueChatTemplates, useUpsertPlugueChatTemplate } from '@/hooks/usePlugueChatConfig';
import type { WhatsAppChannel } from '@/hooks/useWhatsAppChannel';
import { PLUGUECHAT_AUTOMATIONS } from '@/lib/pluguechat-automations';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
}

type TemplateLocalState = Record<string, { enabled: boolean; template_id: string; template_name: string }>;

function buildTemplateState(templates: PlugueChatTemplate[] | undefined): TemplateLocalState {
  const next: TemplateLocalState = {};

  for (const automation of PLUGUECHAT_AUTOMATIONS) {
    const existing = templates?.find((t) => t.type === automation.type);
    next[automation.type] = {
      enabled: existing?.enabled ?? false,
      template_id: existing?.template_id ?? '',
      template_name: existing?.template_name ?? '',
    };
  }

  return next;
}

export default function PlugueChatMessages({ companyId, activeChannel }: Props) {
  const { data: templates, isLoading } = usePlugueChatTemplates(companyId);
  const upsert = useUpsertPlugueChatTemplate();
  const [localState, setLocalState] = useState<TemplateLocalState>({});
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading || hydratedFor === companyId) return;
    setLocalState(buildTemplateState(templates));
    setHydratedFor(companyId);
  }, [templates, companyId, hydratedFor, isLoading]);

  const handleSave = (type: string) => {
    const state = localState[type];
    if (!state) return;

    upsert.mutate({
      company_id: companyId,
      type,
      enabled: state.enabled,
      template_id: state.template_id,
      template_name: state.template_name || null,
    });
  };

  const handleToggle = async (type: string, checked: boolean) => {
    const current = localState[type];
    if (!current) return;

    const next = { ...current, enabled: checked };
    setLocalState((prev) => ({ ...prev, [type]: next }));

    upsert.mutate(
      { company_id: companyId, type, enabled: checked, template_id: current.template_id, template_name: current.template_name || null },
      {
        onError: () => setLocalState((prev) => ({ ...prev, [type]: current })),
      },
    );
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
    <div className="space-y-4">
      {activeChannel !== 'pluguechat_official' && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          O canal ativo não é o PlugueChat Oficial. Os templates salvos aqui só serão usados quando o canal for ativado.
        </div>
      )}

      <div>
        <h3 className="text-lg font-semibold">Automações PlugueChat</h3>
        <p className="text-sm text-muted-foreground">
          Informe o ID do template aprovado na Meta para cada automação. Os parâmetros enviados são fixos por tipo.
        </p>
      </div>

      {PLUGUECHAT_AUTOMATIONS.map((automation) => {
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
                  disabled={upsert.isPending}
                  onCheckedChange={(checked) => void handleToggle(automation.type, checked)}
                />
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Parâmetros enviados pelo sistema:</p>
                <div className="flex flex-wrap gap-2">
                  {automation.parameters.map((param) => (
                    <span key={param} className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      {param}
                    </span>
                  ))}
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`tid-${automation.type}`}>Template ID</Label>
                  <Input
                    id={`tid-${automation.type}`}
                    value={state.template_id}
                    onChange={(e) =>
                      setLocalState((prev) => ({
                        ...prev,
                        [automation.type]: { ...prev[automation.type], template_id: e.target.value },
                      }))
                    }
                    placeholder="ex: reserva_confirmada_v1"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`tname-${automation.type}`}>Nome do template (referência)</Label>
                  <Input
                    id={`tname-${automation.type}`}
                    value={state.template_name}
                    onChange={(e) =>
                      setLocalState((prev) => ({
                        ...prev,
                        [automation.type]: { ...prev[automation.type], template_name: e.target.value },
                      }))
                    }
                    placeholder="Opcional"
                  />
                </div>
              </div>

              <Button
                onClick={() => handleSave(automation.type)}
                disabled={upsert.isPending}
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
  );
}
