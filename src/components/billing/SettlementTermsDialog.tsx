import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  formatSettlementMoney as money,
  formatSettlementTermsRates,
  getSettlementMethodFees,
  parseSettlementRate,
  saveSettlementTerms,
  type SettlementTerms,
} from '@/lib/reservation-settlements-api';

function localDateTime(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Não foi possível concluir a operação.';

export interface SettlementTermsCompany {
  id: string;
  name: string;
  terms: SettlementTerms | null;
  terms_history?: SettlementTerms[];
}

interface SettlementTermsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: SettlementTermsCompany[];
  companyId: string;
  onCompanyChange?: (companyId: string) => void;
  /** Na página da empresa a escolha da empresa fica travada. */
  lockCompany?: boolean;
  onSaved?: () => void | Promise<void>;
}

/** Taxas e regras de repasse de uma empresa, válidas para cobranças novas. */
export default function SettlementTermsDialog({
  open,
  onOpenChange,
  companies,
  companyId,
  onCompanyChange,
  lockCompany,
  onSaved,
}: SettlementTermsDialogProps) {
  const [pixFee, setPixFee] = useState('10');
  const [creditCardFee, setCreditCardFee] = useState('10');
  const [effectiveAt, setEffectiveAt] = useState(localDateTime);
  const [applyNow, setApplyNow] = useState(true);
  const [releasePolicy, setReleasePolicy] = useState<
    'after_reservation' | 'on_settlement'
  >('after_reservation');
  const [holdDays, setHoldDays] = useState('0');
  const [enabled, setEnabled] = useState(false);
  const [formError, setFormError] = useState('');
  const company = companies.find((row) => row.id === companyId);
  useEffect(() => {
    if (!open) return;
    const fees = company?.terms ? getSettlementMethodFees(company.terms) : { pix: 1000, creditCard: 1000 };
    setPixFee(String(fees.pix / 100).replace('.', ','));
    setCreditCardFee(String(fees.creditCard / 100).replace('.', ','));
    setReleasePolicy(company?.terms?.release_policy ?? 'after_reservation');
    setHoldDays(String(company?.terms?.hold_days ?? 0));
    setEnabled(company?.terms?.enabled ?? false);
    setEffectiveAt(localDateTime());
    setApplyNow(true);
    setFormError('');
    // Recarrega o formulário só ao abrir ou trocar de empresa, para não apagar o que está sendo digitado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, open]);
  const pixFeeBps = parseSettlementRate(pixFee);
  const creditCardFeeBps = parseSettlementRate(creditCardFee);
  const validTerms =
    !!companyId &&
    pixFeeBps !== null &&
    creditCardFeeBps !== null &&
    /^\d+$/.test(holdDays) &&
    Number(holdDays) <= 365 &&
    (applyNow ||
      (Number.isFinite(Date.parse(effectiveAt)) &&
        Date.parse(effectiveAt) > Date.now()));
  const saveTerms = useMutation({
    mutationFn: () =>
      saveSettlementTerms({
        company_id: companyId,
        pix_fee_bps: pixFeeBps!,
        credit_card_fee_bps: creditCardFeeBps!,
        release_policy: releasePolicy,
        hold_days: Number(holdDays),
        effective_at: applyNow ? null : new Date(effectiveAt).toISOString(),
        enabled,
      }),
    onSuccess: async () => {
      onOpenChange(false);
      toast.success('Condições comerciais salvas para novas cobranças.');
      await onSaved?.();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  return (
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!saveTerms.isPending) onOpenChange(nextOpen);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (validTerms) saveTerms.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Intermediação das reservas</DialogTitle>
              <DialogDescription>
                Uma nova condição vale para novas cobranças. As taxas das
                cobranças anteriores permanecem preservadas.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="settlement-company">Empresa</Label>
                <Select value={companyId} onValueChange={(value) => onCompanyChange?.(value)} disabled={lockCompany}>
                  <SelectTrigger id="settlement-company">
                    <SelectValue placeholder="Selecione uma empresa" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:gap-4">
                <div className="space-y-2">
                  <Label htmlFor="settlement-pix-fee" className="block min-h-8 text-xs leading-4 sm:min-h-0 sm:text-sm sm:leading-5">
                    Taxa Pix (%)
                  </Label>
                  <Input
                    id="settlement-pix-fee"
                    inputMode="decimal"
                    value={pixFee}
                    onChange={(event) => setPixFee(event.target.value)}
                    aria-describedby="settlement-fee-help"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="settlement-credit-card-fee" className="block min-h-8 text-xs leading-4 sm:min-h-0 sm:text-sm sm:leading-5">
                    Taxa cartão de crédito (%)
                  </Label>
                  <Input
                    id="settlement-credit-card-fee"
                    inputMode="decimal"
                    value={creditCardFee}
                    onChange={(event) => setCreditCardFee(event.target.value)}
                    aria-describedby="settlement-fee-help"
                    required
                  />
                </div>
              </div>
              <p id="settlement-fee-help" className="!mt-2 text-xs text-muted-foreground">
                De 0% a 100% por método, com até duas casas decimais.
              </p>
              {pixFeeBps !== null && creditCardFeeBps !== null && (
                <div className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs">
                  <p className="text-muted-foreground">Em {money(200000)} recebidos, a empresa fica com:</p>
                  <dl className="mt-2 grid grid-cols-2 gap-3">
                    <div><dt className="text-muted-foreground">Pix</dt><dd className="mt-0.5 font-semibold tabular-nums">{money(200000 - Math.round((200000 * pixFeeBps) / 10000))}</dd></div>
                    <div><dt className="text-muted-foreground">Cartão de crédito</dt><dd className="mt-0.5 font-semibold tabular-nums">{money(200000 - Math.round((200000 * creditCardFeeBps) / 10000))}</dd></div>
                  </dl>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">As tarifas do Asaas saem da parte da plataforma.</p>
                </div>
              )}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="settlement-apply-now">
                    Aplicar a partir de agora
                  </Label>
                  <Switch
                    id="settlement-apply-now"
                    checked={applyNow}
                    onCheckedChange={setApplyNow}
                  />
                </div>
                {!applyNow && (
                  <>
                    <Label htmlFor="settlement-effective">Início da vigência</Label>
                    <Input
                      id="settlement-effective"
                      type="datetime-local"
                      step="1"
                      value={effectiveAt}
                      onChange={(event) => setEffectiveAt(event.target.value)}
                      min={localDateTime()}
                      required
                    />
                  </>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="settlement-release">
                  Quando liberar o saldo
                </Label>
                <Select
                  value={releasePolicy}
                  onValueChange={(value) =>
                    setReleasePolicy(value as typeof releasePolicy)
                  }
                >
                  <SelectTrigger id="settlement-release">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="after_reservation">
                      Após disponibilidade e data da reserva
                    </SelectItem>
                    <SelectItem value="on_settlement">
                      Após disponibilidade no Asaas
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="settlement-hold">
                  Prazo adicional de liberação (dias)
                </Label>
                <Input
                  id="settlement-hold"
                  type="number"
                  min="0"
                  max="365"
                  step="1"
                  value={holdDays}
                  onChange={(event) => setHoldDays(event.target.value)}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <Label htmlFor="settlement-enabled">
                    Autorizar novas cobranças
                  </Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ative para permitir pagamentos antecipados conforme as regras
                    da empresa, com a taxa e a vigência definidas aqui. Desativar
                    bloqueia novas cobranças a partir dessa vigência. Pagamentos
                    já criados, saldos e saques continuam disponíveis.
                  </p>
                </div>
                <Switch
                  id="settlement-enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                />
              </div>
              {!!company?.terms_history?.length && (
                <details className="rounded-lg border p-3 text-xs">
                  <summary className="cursor-pointer font-medium">
                    Histórico e condições agendadas
                  </summary>
                  <div className="mt-3 space-y-2">
                    {company.terms_history.map((term) => (
                      <p key={term.id}>
                        {formatSettlementTermsRates(term)} · Vigência{' '}
                        {new Date(term.effective_at).toLocaleString('pt-BR')} ·{' '}
                        {term.enabled ? 'Habilitado' : 'Desabilitado'}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            </div>
            {formError && (
              <p role="alert" className="mb-4 text-sm text-destructive">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saveTerms.isPending}
                onClick={() => onOpenChange(false)}
              >
                Voltar
              </Button>
              <Button
                type="submit"
                disabled={!validTerms || saveTerms.isPending}
              >
                <Save className="mr-2 h-4 w-4" />
                Salvar condições
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
  );
}
