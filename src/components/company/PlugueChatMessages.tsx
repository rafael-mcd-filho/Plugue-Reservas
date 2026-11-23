import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useAutomationDrafts } from '@/hooks/useAutomationDrafts';
import { AUTOMATION_EXAMPLE_VALUES, getAutomationDispatchDescription } from '@/lib/automation-preview';
import PostVisitReviewAvailability from './PostVisitReviewAvailability';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
  onUnsavedChange?: (dirty: boolean) => void;
  saveBlocked?: boolean;
}

type TemplateState = {
  enabled: boolean;
  template_id: string;
  template_name: string;
  post_visit_include_review_link: boolean | null;
};

type TemplateLocalState = Record<string, TemplateState>;

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

export default function PlugueChatMessages({ companyId, activeChannel, onUnsavedChange, saveBlocked = false }: Props) {
  const { data: templates, isLoading, isError, isFetching, refetch } = usePlugueChatTemplates(companyId);
  const { data: npsConfig, isPending: npsLoading, isError: npsError } = useCompanyNpsActivation(companyId);
  const reviewsAvailable = !npsLoading && !npsError && npsConfig?.enabled === true;
  const upsert = useUpsertPlugueChatTemplate();
  const serverState = useMemo(() => buildTemplateState(templates), [templates]);
  const drafts = useAutomationDrafts<TemplateState>(companyId, serverState, !isLoading && !isError && !!templates);
  const localState = drafts.states;
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const currentCompany = useRef(companyId);
  currentCompany.current = companyId;

  useEffect(() => {
    onUnsavedChange?.(drafts.hasUnsavedChanges);
  }, [drafts.hasUnsavedChanges, onUnsavedChange]);

  useEffect(() => {
    return () => onUnsavedChange?.(false);
  }, [onUnsavedChange]);

  useEffect(() => {
    setSaveErrors({});
  }, [companyId]);

  const handleSave = (type: string) => {
    const state = localState[type];
    if (!state || !drafts.isDirty(type) || upsert.isPending || isError || saveBlocked) return;

    setSaveErrors((previous) => ({ ...previous, [type]: '' }));
    upsert.mutate({
      company_id: companyId,
      type,
      enabled: state.enabled,
      template_id: state.template_id,
      template_name: state.template_name || null,
      ...(type === 'post_visit' ? { post_visit_include_review_link: state.post_visit_include_review_link } : {}),
    }, {
      onSuccess: () => {
        if (currentCompany.current !== companyId) return;
        drafts.commit(type, state);
      },
      onError: () => {
        if (currentCompany.current !== companyId) return;
        setSaveErrors((previous) => ({ ...previous, [type]: 'Não foi possível salvar. Suas alterações foram mantidas. Tente novamente.' }));
      },
    });
  };

  if (isLoading || (!drafts.ready && !isError)) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p>Não foi possível carregar os templates. {drafts.ready ? 'Suas alterações foram mantidas. Atualize os dados antes de salvar.' : 'Tente novamente para editar com segurança.'}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>Tentar novamente</Button>
        </div>
      )}
      {activeChannel !== 'pluguechat_official' && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          O canal ativo não é o PlugueChat Oficial. Os templates salvos aqui só serão usados quando o canal for ativado.
        </div>
      )}

      <div>
        <h3 className="text-lg font-semibold">Automações PlugueChat</h3>
        <p className="text-sm text-muted-foreground">
          Informe o ID do template aprovado na Meta para cada automação.
          {' '}Ativação e demais alterações só entram em vigor ao salvar o cartão.
        </p>
      </div>

      {PLUGUECHAT_AUTOMATIONS.map((automation) => {
        const state = localState[automation.type];
        if (!state) return null;

        const Icon = automation.icon;
        const previewParameterValue = (parameter: string) => {
          if (automation.type !== 'post_visit' || parameter !== 'avaliacao') return AUTOMATION_EXAMPLE_VALUES[parameter] ?? 'Exemplo';
          if (!reviewsAvailable) return '"" (vazio)';
          return state.post_visit_include_review_link === null
            ? AUTOMATION_EXAMPLE_VALUES.link_avaliacao
            : AUTOMATION_EXAMPLE_VALUES.avaliacao;
        };

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
                  disabled={upsert.isPending || isError}
                  onCheckedChange={(checked) => drafts.update(automation.type, { enabled: checked })}
                />
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">{getAutomationDispatchDescription(automation.type)}</p>

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
                    disabled={upsert.isPending || isError}
                    onValueChange={(value) => drafts.update('post_visit', { post_visit_include_review_link: value === 'with_review' })}
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
                    {' '}Ao escolher e salvar “Sim”, no PlugueChat, avaliacao recebe apenas o código após /avaliacao/. O endereço completo até /avaliacao/ deve estar no template aprovado, com o slug da sua empresa.
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
                    disabled={upsert.isPending || isError}
                    onChange={(e) => drafts.update(automation.type, { template_id: e.target.value })}
                    placeholder="ex: reserva_confirmada_v1"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`tname-${automation.type}`}>Nome do template (referência)</Label>
                  <Input
                    id={`tname-${automation.type}`}
                    value={state.template_name}
                    disabled={upsert.isPending || isError}
                    onChange={(e) => drafts.update(automation.type, { template_name: e.target.value })}
                    placeholder="Opcional"
                  />
                </div>
              </div>

              <details className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Prévia dos parâmetros</summary>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Exemplo fictício, sem enviar mensagens. O texto final é o template aprovado na Meta e não pode ser consultado por esta prévia.</p>
                {automation.type === 'post_visit' && state.post_visit_include_review_link === null && (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Formato antigo preservado: a variável de avaliação recebe o endereço completo quando disponível ou uma string vazia quando indisponível.</p>
                )}
                {automation.type === 'post_visit' && state.post_visit_include_review_link === true && !reviewsAvailable && (
                  <p className="mt-2 text-xs leading-relaxed text-warning">Sem código de avaliação disponível neste exemplo, o template com avaliação não tem envio elegível. A configuração foi preservada; confira a disponibilidade na tela Avaliações.</p>
                )}
                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  {getPlugueChatAutomationParameters(automation.type, automation.type === 'post_visit' ? state.post_visit_include_review_link : false).map((parameter) => (
                    <div key={parameter} className="min-w-0">
                      <dt className="font-medium">{parameter}:</dt>
                      <dd className="break-words text-muted-foreground">{previewParameterValue(parameter)}</dd>
                    </div>
                  ))}
                </dl>
              </details>

              {saveErrors[automation.type] && <p role="alert" className="text-sm text-destructive">{saveErrors[automation.type]}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => handleSave(automation.type)}
                  disabled={!drafts.isDirty(automation.type) || upsert.isPending || isError || saveBlocked}
                  size="sm"
                  className="gap-2"
                >
                  <Save className="h-4 w-4" /> {saveErrors[automation.type] ? 'Tentar salvar novamente' : 'Salvar'}
                </Button>
                {drafts.isDirty(automation.type) && (
                  <>
                    <Button variant="outline" size="sm" disabled={upsert.isPending} onClick={() => {
                      drafts.discard(automation.type);
                      setSaveErrors((previous) => ({ ...previous, [automation.type]: '' }));
                    }}>Descartar</Button>
                    <span className="text-xs text-muted-foreground">Alterações não salvas</span>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
