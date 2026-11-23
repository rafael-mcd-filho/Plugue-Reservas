import { useState, type ReactNode } from 'react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import ListStateMessage from '@/components/admin/ListStateMessage';
import SettlementTermsDialog from '@/components/billing/SettlementTermsDialog';
import CompanyDialog from '@/components/company/CompanyDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { Company } from '@/hooks/useCompanies';
import { useSuperadminBillingOverview } from '@/hooks/usePlatformBilling';
import {
  formatSettlementMoney,
  formatSettlementTermsRates,
} from '@/lib/reservation-settlements-api';
import { useCompanySettlement } from './useCompanyDetailData';

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function formatDate(value: string | null | undefined, pattern = 'dd/MM/yyyy') {
  if (!value) return '—';
  try { return format(parseISO(value), pattern, { locale: ptBR }); } catch { return '—'; }
}

function InfoGrid({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function CompanyFinanceTab({ company }: { company: Company }) {
  const queryClient = useQueryClient();
  const billingQuery = useSuperadminBillingOverview();
  const settlementQuery = useCompanySettlement(company.id);
  const [billingDialogOpen, setBillingDialogOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  const billingAvailable = billingQuery.data?.available !== false;
  const billing = billingQuery.data?.companies?.find((row) => row.companyId === company.id) ?? null;
  const settlement = settlementQuery.data;
  const pendingWithdrawals = (settlement?.withdrawals ?? []).filter((item) => item.status === 'requested' || item.status === 'under_review');
  const linkNeedsAttention = billing && (billing.linkStatus === 'pending_validation' || billing.linkStatus === 'error' || !!billing.lastSyncError);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">Cobrança da assinatura</CardTitle>
            <CardDescription>Mensalidade que a empresa paga à plataforma.</CardDescription>
          </div>
          {billing && (
            <Badge
              variant="outline"
              className={billing.billingEnabled
                ? 'border-success/25 bg-success-soft text-success'
                : 'border-border bg-muted text-muted-foreground'}
            >
              {billing.billingEnabled ? 'Ativa' : 'Desligada'}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {billingQuery.isPending ? (
            <Skeleton className="h-28 w-full" />
          ) : billingQuery.isError ? (
            <ListStateMessage
              variant="error"
              title="Não foi possível carregar a cobrança"
              actionLabel="Tentar novamente"
              onAction={() => void billingQuery.refetch()}
              className="min-h-32 py-4"
            />
          ) : !billingAvailable ? (
            <p className="text-sm text-muted-foreground">O módulo de mensalidades ainda não está disponível neste ambiente.</p>
          ) : !billing?.configured ? (
            <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
              Sem vínculo no Asaas. Sem ele, a empresa não recebe a cobrança da assinatura.
            </p>
          ) : (
            <InfoGrid
              rows={[
                ['Cliente no Asaas', (
                  <span>
                    {billing.customerName || billing.customerId}
                    {linkNeedsAttention && <span className="ml-2 text-xs font-medium text-destructive">precisa de atenção</span>}
                  </span>
                )],
                ['Em aberto', (
                  <span>
                    {currency.format(billing.openTotal)} · {billing.openCount} {billing.openCount === 1 ? 'cobrança' : 'cobranças'}
                    {billing.overdueCount > 0
                      ? <span className="block text-xs font-semibold text-destructive">{currency.format(billing.overdueTotal)} vencido</span>
                      : billing.openCount > 0 && <span className="block text-xs text-muted-foreground">nada vencido</span>}
                  </span>
                )],
                ['Próximo vencimento', billing.nextDueDate ? `${formatDate(billing.nextDueDate)} · ${currency.format(billing.nextDueAmount)}` : '—'],
                ['Última sincronização', formatDate(billing.lastSyncedAt, "dd/MM 'às' HH:mm")],
              ]}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setBillingDialogOpen(true)} disabled={!billingAvailable}>
              {billing?.configured ? 'Configurar cobrança' : 'Vincular cliente do Asaas'}
            </Button>
            {billing?.configured && (
              <Button asChild variant="outline">
                <Link to={`/financeiro/empresa/${company.id}`}>Ver faturas</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">Repasses das reservas</CardTitle>
            <CardDescription>Pagamentos antecipados que a plataforma repassa à empresa.</CardDescription>
          </div>
          {settlement?.terms && (
            <Badge
              variant="outline"
              className={settlement.terms.enabled
                ? 'border-success/25 bg-success-soft text-success'
                : 'border-border bg-muted text-muted-foreground'}
            >
              {settlement.terms.enabled ? 'Cobranças novas habilitadas' : 'Cobranças novas desabilitadas'}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {settlementQuery.isPending ? (
            <Skeleton className="h-28 w-full" />
          ) : settlementQuery.isError ? (
            <ListStateMessage
              variant="error"
              title="Não foi possível carregar os repasses"
              description={settlementQuery.error instanceof Error ? settlementQuery.error.message : undefined}
              actionLabel="Tentar novamente"
              onAction={() => void settlementQuery.refetch()}
              className="min-h-32 py-4"
            />
          ) : settlement ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['Disponível', settlement.available_cents],
                  ['A liberar', settlement.pending_cents],
                  ['Em conferência', settlement.blocked_cents ?? 0],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-lg bg-muted/50 p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-0.5 font-semibold tabular-nums">{formatSettlementMoney(value as number)}</p>
                  </div>
                ))}
              </div>
              <InfoGrid
                rows={[
                  ['Taxas', settlement.terms ? formatSettlementTermsRates(settlement.terms) : 'Ainda não definidas'],
                  ['Liberação do saldo', settlement.terms
                    ? `${settlement.terms.release_policy === 'on_settlement' ? 'Na compensação do Asaas' : 'Após a data da reserva'}${settlement.terms.hold_days > 0 ? ` + ${settlement.terms.hold_days} ${settlement.terms.hold_days === 1 ? 'dia' : 'dias'}` : ''}`
                    : '—'],
                  ['Saques', pendingWithdrawals.length > 0
                    ? <Link to="/financeiro?aba=repasses" className="font-medium text-accent-foreground hover:underline">{pendingWithdrawals.length} aguardando análise</Link>
                    : 'Nenhum pedido pendente'],
                ]}
              />
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setTermsOpen(true)} disabled={!settlement}>Editar taxas</Button>
          </div>
        </CardContent>
      </Card>

      <CompanyDialog
        open={billingDialogOpen}
        company={null}
        billingTarget={{ id: company.id, name: company.name, status: company.status === 'paused' ? 'paused' : 'active' }}
        onOpenChange={setBillingDialogOpen}
      />
      <SettlementTermsDialog
        open={termsOpen}
        onOpenChange={setTermsOpen}
        companies={settlement ? [{ id: company.id, name: company.name, terms: settlement.terms, terms_history: settlement.terms_history }] : []}
        companyId={company.id}
        lockCompany
        onSaved={async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['reservation-settlements'] }),
            queryClient.invalidateQueries({ queryKey: ['admin-reservation-settlements'] }),
          ]);
        }}
      />
    </div>
  );
}
