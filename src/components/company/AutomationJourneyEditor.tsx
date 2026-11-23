import { useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { WHATSAPP_AUTOMATIONS, type WhatsAppAutomationDefinition } from '@/lib/whatsapp-automations';
import { getAutomationDispatchDescription, getAutomationPreview } from '@/lib/automation-preview';
import PostVisitReviewAvailability from './PostVisitReviewAvailability';

type AutomationDraft = { enabled: boolean; message_template: string };

interface AutomationJourneyEditorProps {
  states: Record<string, AutomationDraft>;
  isDirty: (type: string) => boolean;
  onChange: (type: string, patch: Partial<AutomationDraft>) => void;
  onDiscard: (type: string) => void;
  onSave: (type: string) => void;
  saving: boolean;
  savingType: string | null;
  saveErrors: Record<string, boolean>;
  saveDisabled: boolean;
  reviewsAvailable: boolean;
  npsLoading: boolean;
  npsError: boolean;
}

// Agrupa pelas etapas da jornada do cliente; tipos novos que não estiverem aqui vão para "Outras".
const JOURNEY_GROUPS: { label: string; types: string[] }[] = [
  { label: 'Ao reservar', types: ['confirmation_message', 'cancellation_message'] },
  { label: 'Antes da visita', types: ['reminder_24h', 'reminder_1h'] },
  { label: 'Depois da visita', types: ['post_visit', 'no_show_message'] },
  { label: 'Relacionamento', types: ['birthday_message', 'reactivation_30d'] },
  { label: 'Fila de espera', types: ['waitlist_entry', 'waitlist_called'] },
];

// Quando cada mensagem sai, em poucas palavras, para a lista.
const SHORT_WHEN: Record<string, string> = {
  confirmation_message: 'assim que a reserva é criada',
  cancellation_message: 'quando a reserva é cancelada',
  reminder_24h: 'no dia anterior, durante o dia',
  reminder_1h: 'algumas horas antes, nunca com menos de 1 hora',
  post_visit: 'às 08:00 do dia seguinte ao check-in',
  no_show_message: 'às 09:00 do dia seguinte à falta',
  birthday_message: '4 dias antes do aniversário',
  reactivation_30d: 'quando completa 30 dias sem visita',
  waitlist_entry: 'quando o cliente entra na fila',
  waitlist_called: 'quando o cliente é chamado da fila',
};

const VARIABLE_LABELS: Record<string, string> = {
  nome: 'Nome',
  pessoas: 'Pessoas',
  data: 'Data',
  hora: 'Horário',
  telefone: 'Telefone',
  link_acompanhamento: 'Link da reserva',
  link_avaliacao: 'Link da avaliação',
  posicao: 'Posição na fila',
  dias_sem_visita: 'Dias sem visita',
  data_ultima_visita: 'Data da última visita',
  link_reserva: 'Link para reservar',
};

function buildGroups() {
  const known = new Set(JOURNEY_GROUPS.flatMap((group) => group.types));
  const byType = new Map(WHATSAPP_AUTOMATIONS.map((automation) => [automation.type, automation]));
  const groups = JOURNEY_GROUPS.map((group) => ({
    label: group.label,
    items: group.types.map((type) => byType.get(type)).filter((item): item is WhatsAppAutomationDefinition => !!item),
  }));
  const others = WHATSAPP_AUTOMATIONS.filter((automation) => !known.has(automation.type));
  if (others.length > 0) groups.push({ label: 'Outras', items: others });
  return groups.filter((group) => group.items.length > 0);
}

const AUTOMATION_GROUPS = buildGroups();
const FIRST_TYPE = AUTOMATION_GROUPS[0]?.items[0]?.type ?? WHATSAPP_AUTOMATIONS[0]?.type;

/** Lista das automações por etapa da jornada e editor da selecionada, com prévia no celular. */
export default function AutomationJourneyEditor({
  states,
  isDirty,
  onChange,
  onDiscard,
  onSave,
  saving,
  savingType,
  saveErrors,
  saveDisabled,
  reviewsAvailable,
  npsLoading,
  npsError,
}: AutomationJourneyEditorProps) {
  const [selectedType, setSelectedType] = useState<string>(FIRST_TYPE);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLElement>(null);

  const automation = WHATSAPP_AUTOMATIONS.find((item) => item.type === selectedType) ?? WHATSAPP_AUTOMATIONS[0];
  const state = automation ? states[automation.type] : undefined;

  const selectAutomation = (type: string) => {
    setSelectedType(type);
    // No celular o editor fica abaixo da lista: leva a pessoa até ele.
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches) {
      requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  };

  const insertVariable = (variable: string) => {
    if (!automation || !state) return;
    const token = `{${variable}}`;
    const textarea = textareaRef.current;
    const text = state.message_template;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? text.length;
    onChange(automation.type, { message_template: `${text.slice(0, start)}${token}${text.slice(end)}` });
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      const caret = start + token.length;
      textarea.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <section aria-label="Lista de automações" className="min-w-0 overflow-hidden rounded-xl border border-border bg-white shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <h4 className="text-sm font-semibold text-foreground">Automações</h4>
          <p className="text-xs text-muted-foreground">Escolha uma mensagem para editar o texto e ligar ou desligar.</p>
        </div>
        {AUTOMATION_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="bg-muted/40 px-4 pb-1.5 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            <ul>
              {group.items.map((item) => {
                const itemState = states[item.type];
                if (!itemState) return null;
                const selected = item.type === automation?.type;
                const dirty = isDirty(item.type);
                return (
                  <li key={item.type} className="border-b border-border/60 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => selectAutomation(item.type)}
                      aria-current={selected ? 'true' : undefined}
                      className={cn(
                        'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        selected && 'bg-primary-soft shadow-[inset_3px_0_0_hsl(var(--primary))] hover:bg-primary-soft',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{item.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{SHORT_WHEN[item.type] ?? item.description}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 text-xs font-medium',
                            itemState.enabled ? 'text-success' : 'text-muted-foreground',
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn('h-2 w-2 rounded-full', itemState.enabled ? 'bg-success' : 'bg-muted-foreground/40')}
                          />
                          {itemState.enabled ? 'Ligada' : 'Desligada'}
                        </span>
                        {dirty && <span className="text-[11px] font-semibold text-warning">não salva</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      {automation && state && (
        <section
          ref={editorRef}
          aria-label={`Editar: ${automation.label}`}
          className="bg-card min-w-0 scroll-mt-4 rounded-xl border border-border shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-foreground">{automation.label}</h3>
              <p className="text-xs text-muted-foreground">{automation.description}</p>
            </div>
            <label className="inline-flex items-center gap-2 text-sm font-medium">
              <Switch
                aria-label={`Ativar ${automation.label}`}
                checked={state.enabled}
                disabled={saving}
                onCheckedChange={(checked) => onChange(automation.type, { enabled: checked })}
              />
              {state.enabled ? 'Ligada' : 'Desligada'}
            </label>
          </div>

          <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_240px]">
            <div className="min-w-0 space-y-3">
              {automation.type === 'post_visit' && reviewsAvailable && (
                <div className="space-y-2">
                  <PostVisitReviewAvailability
                    active={reviewsAvailable}
                    loading={npsLoading}
                    error={npsError}
                    usesReview={state.message_template.includes('{link_avaliacao}')}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Na API não oficial, {'{link_avaliacao}'} recebe o endereço completo da avaliação. Para enviar apenas o agradecimento, não inclua essa variável nem o convite de avaliação no texto.
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Inserir no texto</p>
                <div className="flex flex-wrap gap-1.5">
                  {automation.variables
                    .filter((variable) => variable !== 'link_avaliacao' || reviewsAvailable)
                    .map((variable) => (
                      <button
                        key={variable}
                        type="button"
                        disabled={saving}
                        onClick={() => insertVariable(variable)}
                        aria-label={`Inserir ${VARIABLE_LABELS[variable] ?? variable}`}
                        title={`Insere {${variable}} no ponto do cursor`}
                        className="inline-flex min-h-7 items-center rounded-full bg-primary-soft px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        + {VARIABLE_LABELS[variable] ?? variable}
                      </button>
                    ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`automation-message-${automation.type}`}>Mensagem</Label>
                <Textarea
                  ref={textareaRef}
                  id={`automation-message-${automation.type}`}
                  value={state.message_template}
                  disabled={saving}
                  onChange={(event) => onChange(automation.type, { message_template: event.target.value })}
                  rows={12}
                  className="min-h-[260px] resize-y"
                  placeholder="Digite o modelo da mensagem..."
                />
              </div>

              {isDirty(automation.type) && (
                <p role="status" className="text-xs font-medium text-warning">Alterações não salvas</p>
              )}
              {saveErrors[automation.type] && (
                <p role="alert" className="text-sm text-destructive">
                  Não foi possível salvar. Suas alterações foram mantidas. Tente novamente.
                </p>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                {isDirty(automation.type) && (
                  <Button variant="outline" size="sm" disabled={saving} onClick={() => onDiscard(automation.type)}>
                    Descartar
                  </Button>
                )}
                <Button
                  onClick={() => onSave(automation.type)}
                  disabled={saving || !isDirty(automation.type) || saveDisabled}
                  size="sm"
                  className="gap-2"
                >
                  <Save className="h-4 w-4" />
                  {savingType === automation.type ? 'Salvando...' : 'Salvar'}
                </Button>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <div className="rounded-[22px] bg-[#1C1712] p-2 shadow-sm">
                <div className="flex min-h-[300px] max-h-[460px] flex-col gap-2 overflow-y-auto overscroll-contain rounded-2xl bg-[#ECE5DD] p-3">
                  <span className="self-center rounded-md bg-white/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                    Prévia com dados de exemplo
                  </span>
                  <p
                    className="max-w-[92%] self-start whitespace-pre-wrap break-words rounded-lg rounded-tl-none bg-white px-3 py-2 text-[13px] leading-snug text-foreground shadow-sm"
                    data-testid={`automation-preview-${automation.type}`}
                  >
                    {getAutomationPreview(state.message_template, reviewsAvailable)}
                  </p>
                </div>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Nenhuma mensagem será enviada por esta prévia. {getAutomationDispatchDescription(automation.type)}
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
