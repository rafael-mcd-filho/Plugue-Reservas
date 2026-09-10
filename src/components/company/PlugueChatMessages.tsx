import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { type PlugueChatTemplate, usePlugueChatTemplates, useUpsertPlugueChatTemplate } from '@/hooks/usePlugueChatConfig';
import type { WhatsAppChannel } from '@/hooks/useWhatsAppChannel';
import { getPlugueChatAutomationParameters, PLUGUECHAT_AUTOMATIONS } from '@/lib/pluguechat-automations';
import { useCompanyNpsActivation } from '@/hooks/useCompanyNpsActivation';
import PostVisitReviewAvailability from './PostVisitReviewAvailability';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
}

type TemplateLocalState = Record<string, {
  enabled: boolean;
  template_id: string;
  template_name: string;
  post_visit_include_review_link: boolean | null;
}>;

function buildTemplateState(templates: PlugueChatTemplate[] | undefined): TemplateLocalState {
  const next: TemplateLocalState = {};

  for (const automation of PLUGUECHAT_AUTOMATIONS) {
    const existing = templates?.find((t) => t.type === automation.type);
    next[automation.type] = {
      enabled: existing?.enabled ?? false,
      template_id: existing?.template_id ?? '',
      template_name: existing?.template_name ?? '',
      post_visit_include_review_link: existing ? existing.post_visit_include_review_link ?? null : false,
    };
  }

  return next;
}

export default function PlugueChatMessages({ companyId, activeChannel }: Props) {
  const { data: templates, isLoading } = usePlugueChatTemplates(companyId);
  const { data: npsConfig, isPending: npsLoading, isError: npsError } = useCompanyNpsActivation(companyId);
  const reviewsAvailable = !npsLoading && !npsError && npsConfig?.enabled === true;
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
      ...(type === 'post_visit' ? { post_visit_include_review_link: state.post_visit_include_review_link } : {}),
    });
  };

  const handleToggle = async (type: string, checked: boolean) => {
    const current = localState[type];
    if (!current) return;

    const next = { ...current, enabled: checked };
    setLocalState((prev) => ({ ...prev, [type]: next }));

    upsert.mutate(
      {
        company_id: companyId, type, enabled: checked,
        template_id: current.template_id, template_name: current.template_name || null,
        ...(type === 'post_visit' ? { post_visit_include_review_link: current.post_visit_include_review_link } : {}),
      },
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
          Informe o ID do template aprovado na Meta para cada automação.
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
                  aria-label={`Ativar ${automation.label}`}
                  checked={state.enabled}
                  disabled={upsert.isPending}
                  onCheckedChange={(checked) => void handleToggle(automation.type, checked)}
                />
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {automation.type === 'post_visit' ? 'Variáveis disponíveis:' : 'Parâmetros enviados pelo sistema:'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {getPlugueChatAutomationParameters(automation.type, reviewsAvailable).map((param) => (
                    <span key={param} className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      {param}
                    </span>
                  ))}
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              {automation.type === 'post_visit' && reviewsAvailable && (
                <div className="space-y-3">
                  <PostVisitReviewAvailability
                    active={reviewsAvailable} loading={npsLoading} error={npsError}
                    usesReview={state.post_visit_include_review_link} official
                  />
                  <p id="post-visit-review-label" className="text-sm font-medium">Este template utiliza a variável de avaliação?</p>
                  <RadioGroup
                    aria-labelledby="post-visit-review-label"
                    aria-describedby="post-visit-review-help"
                    value={state.post_visit_include_review_link === null ? '' : state.post_visit_include_review_link ? 'with_review' : 'without_review'}
                    disabled={upsert.isPending}
                    onValueChange={(value) => setLocalState((prev) => ({
                      ...prev,
                      post_visit: { ...prev.post_visit, post_visit_include_review_link: value === 'with_review' },
                    }))}
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem id="post-visit-without-review" value="without_review" />
                      <Label htmlFor="post-visit-without-review">Não — somente nome e data</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem id="post-visit-with-review" value="with_review" disabled={!reviewsAvailable} />
                      <Label htmlFor="post-visit-with-review">Sim — inclui o código da avaliação</Label>
                    </div>
                  </RadioGroup>
                  <p id="post-visit-review-help" className="text-xs leading-relaxed text-muted-foreground">
                    Ative ou desative as avaliações somente na tela Avaliações. A escolha acima descreve o template aprovado; não ativa a funcionalidade.
                    {' '}Ao escolher e salvar “Sim”, no PlugueChat, link_avaliacao recebe apenas o código após /avaliacao/. O endereço completo até /avaliacao/ deve estar no template aprovado, com o slug da sua empresa.
                    {' '}Na API não oficial, a variável continua recebendo o link completo.
                  </p>
                  {state.post_visit_include_review_link === null ? (
                    <p role="status" className="text-xs leading-relaxed text-warning">
                      Configuração antiga não revisada: o envio anterior está preservado, incluindo link completo ou vazio, até escolher e salvar “Sim” ou “Não”. Confira as variáveis e o ID do template aprovado antes de mudar o formato.
                    </p>
                  ) : state.post_visit_include_review_link ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Se não houver código de avaliação, esta mensagem não será enviada com campo vazio. A coleta de avaliações precisa estar ativa no momento do check-in para gerar novos códigos.
                    </p>
                  ) : (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Use um template sem variável ou botão de avaliação. Nenhum código de avaliação será enviado, mesmo se já existir. Para mudar de formato, informe o ID do template correspondente e salve.
                    </p>
                  )}
                </div>
              )}
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
