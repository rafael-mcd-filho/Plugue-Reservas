import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Clock3, Info, RefreshCw, ShieldCheck } from 'lucide-react';
import { useSettlementPanelAccess } from '@/hooks/useSettlementPanelAccess';
import { Button } from '@/components/ui/button';
import {
  formatSettlementMoney as money,
  formatSettlementTermsRates,
  getSettlementOverview,
  type SettlementOverview,
} from '@/lib/reservation-settlements-api';

interface Props {
  companyId: string;
  onOpenWithdrawals: () => void;
}

const balanceFields: Array<keyof SettlementOverview> = [
  'gross_cents', 'refunded_cents', 'chargeback_cents', 'fee_cents', 'merchant_net_cents',
  'available_cents', 'pending_cents', 'blocked_cents', 'reserved_cents', 'paid_cents',
];

export default function PrepaymentBalanceDashboard({ companyId, onOpenWithdrawals }: Props) {
  const { canRead, isLoading: accessLoading } = useSettlementPanelAccess(companyId);
  const restricted = !accessLoading && !canRead;
  const query = useQuery({
    queryKey: ['reservation-settlements', companyId, 0],
    queryFn: () => getSettlementOverview(companyId),
    enabled: !!companyId && canRead,
    retry: false,
  });
  const overview = query.data;
  const invalid = overview && balanceFields.some(field => !Number.isSafeInteger(overview[field]));

  if (restricted) return (
    <section aria-label="Saldo acumulado" className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
      <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
      <div><h2 className="text-sm font-semibold">Saldo e saques da empresa</h2>
        <p className="mt-1 text-sm text-muted-foreground">Entre com o administrador da empresa para consultar o saldo e gerenciar os saques.</p>
      </div>
    </section>
  );

  if (!accessLoading && (query.isError || invalid)) return (
    <section aria-label="Saldo acumulado" className="rounded-xl border border-destructive/20 bg-card p-4">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div><h2 className="font-semibold">Não foi possível consultar seu saldo</h2>
          <p role="alert" className="mt-1 max-w-2xl text-sm text-muted-foreground">Os valores acumulados estão indisponíveis neste momento. Atualize para consultar o saldo antes de solicitar um saque.</p>
        </div>
        <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching} className="gap-2 self-start"><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />Atualizar saldo</Button>
      </div>
    </section>
  );

  if (accessLoading || !overview) return (
    <section aria-label="Saldo acumulado" role="status" className="overflow-hidden rounded-xl border border-border bg-card">
      <span className="sr-only">Consultando saldo acumulado…</span>
      <div className="grid lg:grid-cols-[minmax(240px,0.9fr)_2.1fr]">
        <div className="space-y-3 bg-success-soft/60 p-4"><div className="h-3 w-32 rounded bg-success/10" /><div className="h-8 w-40 rounded bg-success/10 motion-safe:animate-pulse" /><div className="h-8 w-32 rounded bg-success/10" /></div>
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">{[1, 2, 3, 4].map(item => <div key={item} className="space-y-2"><div className="h-3 w-3/4 rounded bg-muted" /><div className="h-5 w-2/3 rounded bg-muted motion-safe:animate-pulse" /></div>)}</div>
      </div>
    </section>
  );

  return (
    <section aria-label="Saldo acumulado" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="grid lg:grid-cols-[minmax(240px,0.9fr)_2.1fr]">
        <div className="flex min-w-0 flex-col gap-3 bg-success p-4 text-success-foreground">
          <div>
            <h2 className="text-xs font-medium text-success-foreground/85">Disponível para saque</h2>
            <p data-testid="available-balance" className="mt-1 break-words text-[clamp(1.5rem,2.2vw,2rem)] font-semibold leading-tight tracking-[-0.035em] tabular-nums">{money(overview.available_cents)}</p>
            {overview.available_cents < 0 && <p className="mt-2 text-xs leading-relaxed text-success-foreground/80">
              {overview.blocked_cents > 0
                ? 'Há valores em conferência. Aguarde a conciliação para novos saques.'
                : 'Novos recebimentos compensarão o saldo a regularizar.'}
            </p>}
          </div>
          <Button onClick={onOpenWithdrawals} size="sm" variant="secondary" className="h-9 w-fit gap-2 border-0 bg-success-foreground text-success shadow-none hover:bg-success-foreground/90 lg:h-8">Gerenciar saques<ArrowUpRight className="h-3.5 w-3.5" /></Button>
        </div>

        <div className="flex min-w-0 flex-col">
          <dl className="grid flex-1 grid-cols-2 content-center gap-x-4 gap-y-3 p-4 sm:grid-cols-4 lg:gap-x-3">
            {[
              ['Total confirmado', overview.gross_cents],
              ['Líquido da empresa', overview.merchant_net_cents],
              ['Saques pagos', overview.paid_cents],
              ['Reservado em saques', overview.reserved_cents],
            ].map(([label, amount]) => <div key={label} className="min-w-0">
              <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-words text-base font-semibold tracking-tight tabular-nums">{money(Number(amount))}</dd>
            </div>)}
          </dl>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border bg-muted/15 px-4 py-2.5 text-[11px]">
            <div className="inline-flex items-center gap-2 text-muted-foreground"><ArrowDownLeft className="h-3.5 w-3.5" />A liberar <strong className="font-semibold text-foreground tabular-nums">{money(overview.pending_cents)}</strong></div>
            <div className="inline-flex items-center gap-2 text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" />Em conferência <strong className="font-semibold text-foreground tabular-nums">{money(overview.blocked_cents)}</strong></div>
          </div>
        </div>
      </div>
      <div className="flex flex-col justify-between gap-2 border-t border-border px-4 py-2.5 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />Independente do período</span>
          <span className="font-medium text-foreground">{overview.terms ? formatSettlementTermsRates(overview.terms) : 'Intermediação a definir'}</span>
          <span>Tarifas de processamento incluídas</span>
        </div>
        <details className="min-w-0 text-xs text-muted-foreground sm:max-w-lg">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-foreground"><Info className="h-3.5 w-3.5" />Como meu saldo é calculado?</summary>
          <div className="mt-3 space-y-1.5 border-l-2 border-success/20 pl-3 text-[11px] leading-relaxed">
            <p>Confirmados {money(overview.gross_cents)} − estornos {money(overview.refunded_cents)} − chargebacks {money(overview.chargeback_cents)} − intermediação {money(overview.fee_cents)} = líquido {money(overview.merchant_net_cents)}.</p>
            <p>Do líquido, saem os saques pagos, pedidos reservados, valores a liberar e em conferência. O saldo acima considera todo o histórico elegível e não muda com o filtro de datas abaixo.</p>
            <p>{overview.terms?.release_policy === 'after_reservation' ? 'A liberação aguarda a liquidação do pagamento e a passagem da data da reserva.' : 'A liberação aguarda a liquidação do pagamento.'}{overview.terms && overview.terms.hold_days > 0 ? ` Prazo adicional: ${overview.terms.hold_days} dia(s).` : ''}</p>
          </div>
        </details>
      </div>
      {!overview.terms?.enabled && <p className="border-t border-border bg-warning-soft/30 px-4 py-2 text-xs leading-relaxed text-muted-foreground">Novas cobranças aguardam condições comerciais habilitadas pela plataforma. Os saldos e pedidos existentes continuam preservados.</p>}
    </section>
  );
}
