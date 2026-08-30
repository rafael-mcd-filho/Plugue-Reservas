import { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  QrCode,
  RefreshCw,
  ReceiptText,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import BillingStatusBadge from '@/components/billing/BillingStatusBadge';
import InvoicePixDialog from '@/components/billing/InvoicePixDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import {
  canGenerateBillingInvoicePix,
  sortBillingInvoicesByNewestDueDate,
} from '@/lib/company-billing-invoices';
import { isCompanyBillingPixQrCodeValid } from '@/lib/company-billing-pix-client';
import type { CompanyBillingInvoice } from '@/lib/platform-billing-contracts';
import {
  useCompanyBillingInvoicePixQrCode,
  useCompanyBillingInvoices,
  useCompanyBillingLink,
  useCompanyBillingSummary,
  usePlatformBillingModuleStatus,
} from '@/hooks/usePlatformBilling';

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

function formatDate(value: string | null | undefined, fallback = '—') {
  if (!value) return fallback;
  try {
    return format(parseISO(value), 'dd/MM/yyyy', { locale: ptBR });
  } catch {
    return fallback;
  }
}

function formatDateTime(value: string | null | undefined, fallback = 'Nunca sincronizado') {
  if (!value) return fallback;
  try {
    return format(parseISO(value), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  } catch {
    return fallback;
  }
}

function billingTypeLabel(value: string | null | undefined) {
  const normalized = String(value || '').toUpperCase();
  if (normalized === 'PIX') return 'Pix';
  if (normalized === 'BOLETO') return 'Boleto';
  if (normalized === 'CREDIT_CARD') return 'Cartão';
  if (normalized === 'UNDEFINED') return 'A definir';
  return value || '—';
}

function toSafeExternalUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export default function CompanyBilling() {
  const { companyId, companyName } = useCompanySlug();

  return <CompanyBillingView key={companyId} companyId={companyId} companyName={companyName} />;
}

interface CompanyBillingViewProps {
  companyId: string;
  companyName: string;
  allowWhenDisabled?: boolean;
}

export function CompanyBillingView({
  companyId,
  companyName,
  allowWhenDisabled = false,
}: CompanyBillingViewProps) {
  const moduleQuery = usePlatformBillingModuleStatus();
  const moduleStatus = moduleQuery.data;
  const summaryQuery = useCompanyBillingSummary(companyId, { allowWhenDisabled });
  const companyBillingEnabled = !!summaryQuery.data?.companyBillingEnabled;
  const isPreviewMode = allowWhenDisabled
    && !!moduleStatus?.available
    && (!moduleStatus.enabled || !companyBillingEnabled);
  const billingShouldLoad = allowWhenDisabled
    || (!!moduleStatus?.enabled && companyBillingEnabled);
  const linkQuery = useCompanyBillingLink(companyId, { enabled: billingShouldLoad });
  const invoicesQuery = useCompanyBillingInvoices(companyId, {
    allowWhenDisabled,
    enabled: billingShouldLoad,
  });
  const invoicePixQrCode = useCompanyBillingInvoicePixQrCode();
  const [selectedPixInvoice, setSelectedPixInvoice] = useState<CompanyBillingInvoice | null>(null);

  const link = linkQuery.data;
  const summary = summaryQuery.data;
  const invoices = invoicesQuery.data;
  const effectiveLinkStatus = summary?.linkStatus ?? link?.status;
  const effectiveLastSyncedAt = summary?.lastSyncedAt ?? link?.lastSyncedAt ?? null;
  const effectiveLastSyncError = summary?.lastSyncError ?? link?.lastSyncError ?? null;
  const isLoading = (moduleQuery.isFetching && !moduleStatus?.available)
    || summaryQuery.isLoading
    || (billingShouldLoad && linkQuery.isLoading)
    || (billingShouldLoad && summaryQuery.isPlaceholderData)
    || invoicesQuery.isLoading
    || (billingShouldLoad && invoicesQuery.isPlaceholderData);
  const sortedInvoices = useMemo(
    () => sortBillingInvoicesByNewestDueDate(invoices ?? []),
    [invoices],
  );
  const selectedPixData = selectedPixInvoice
    && invoicePixQrCode.data?.invoiceId === selectedPixInvoice.id
    ? invoicePixQrCode.data
    : null;
  const selectedPixRequestMatches = !!selectedPixInvoice
    && invoicePixQrCode.variables?.invoiceId === selectedPixInvoice.id;

  const requestInvoicePix = (invoice: CompanyBillingInvoice) => {
    void invoicePixQrCode.mutateAsync({ companyId, invoiceId: invoice.id })
      .catch(() => undefined);
  };

  const handleOpenPix = (invoice: CompanyBillingInvoice) => {
    setSelectedPixInvoice(invoice);
    if (
      invoicePixQrCode.data?.invoiceId === invoice.id
      && isCompanyBillingPixQrCodeValid(invoicePixQrCode.data)
    ) {
      return;
    }
    requestInvoicePix(invoice);
  };

  const handlePixDialogOpenChange = (open: boolean) => {
    if (open) return;
    setSelectedPixInvoice(null);
  };

  if (isLoading) {
    return <CompanyBillingSkeleton />;
  }

  const hasBlockingBillingError = (moduleQuery.isError && moduleStatus === undefined)
    || (linkQuery.isError && link === undefined)
    || (summaryQuery.isError && summary === undefined)
    || (invoicesQuery.isError && invoices === undefined);

  if (hasBlockingBillingError) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <PageHeader companyName={companyName} />
        {isPreviewMode && (
          <BillingPreviewBanner
            globalEnabled={!!moduleStatus?.enabled}
            companyEnabled={companyBillingEnabled}
          />
        )}
        <Card className="border-warning/25 shadow-sm">
          <CardContent className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-warning-soft text-amber-800">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <h2 className="font-semibold">Não foi possível carregar o Financeiro</h2>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              A leitura falhou, por isso nenhum total foi exibido como zero e nenhuma lista foi tratada como vazia. As demais áreas continuam disponíveis.
            </p>
            <Button
              variant="outline"
              onClick={() => void Promise.all([
                moduleQuery.refetch(),
                linkQuery.refetch(),
                summaryQuery.refetch(),
                invoicesQuery.refetch(),
              ])}
              className="mt-4 gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if ((!moduleStatus?.enabled || !companyBillingEnabled) && !isPreviewMode) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <PageHeader companyName={companyName} />
        <Card className="border-dashed shadow-none">
          <CardContent className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <WalletCards className="h-5 w-5" />
            </div>
            <h2 className="font-semibold">
              {!moduleStatus?.enabled ? 'Financeiro temporariamente indisponível' : 'Financeiro ainda não liberado'}
            </h2>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              {!moduleStatus?.enabled
                ? 'O módulo ainda não foi habilitado pela Plugue Guest. Nenhuma ação é necessária por enquanto.'
                : 'As cobranças desta empresa ainda não foram liberadas pela Plugue Guest. Nenhuma fatura ou total será exibido até a ativação.'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasUsableCachedBilling = effectiveLinkStatus === 'error' && !!effectiveLastSyncedAt;
  if (!link?.customerId || (effectiveLinkStatus !== 'active' && !hasUsableCachedBilling)) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <PageHeader companyName={companyName} />
        {isPreviewMode && (
          <BillingPreviewBanner
            globalEnabled={!!moduleStatus?.enabled}
            companyEnabled={companyBillingEnabled}
          />
        )}
        <Card className="overflow-hidden border-dashed shadow-none">
          <div className="h-1 bg-primary/70" />
          <CardContent className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-primary/15 bg-primary-soft text-primary">
              <ReceiptText className="h-5 w-5" />
            </div>
            <h2 className="font-semibold">
              {effectiveLinkStatus === 'error' ? 'Vínculo financeiro precisa de atenção' : 'Financeiro em configuração'}
            </h2>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
              {effectiveLinkStatus === 'error'
                ? 'A Plugue Guest foi notificada para revisar a conexão desta unidade com o Asaas. A operação do sistema não é afetada.'
                : 'A Plugue Guest ainda está vinculando as cobranças desta unidade. Quando a configuração for concluída, suas faturas aparecerão aqui automaticamente.'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const overdueCount = summary?.overdueCount ?? 0;
  const overdueAmount = Number(summary?.overdueTotal ?? 0);
  const openCount = summary?.openCount ?? 0;
  const openAmount = Number(summary?.openTotal ?? 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader companyName={companyName} />

      {isPreviewMode && (
        <BillingPreviewBanner
          globalEnabled={!!moduleStatus?.enabled}
          companyEnabled={companyBillingEnabled}
        />
      )}

      {overdueCount > 0 && (
        <div className="flex flex-col gap-4 rounded-xl border border-destructive/25 bg-destructive-soft/55 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg border border-destructive/20 bg-background p-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div>
              <p className="font-semibold text-foreground">
                {overdueCount === 1 ? 'Uma fatura está vencida' : `${overdueCount} faturas estão vencidas`}
              </p>
              <p className="mt-1 text-sm text-foreground/65">
                Total de {currencyFormatter.format(overdueAmount)} aguardando pagamento.
              </p>
            </div>
          </div>
          {summary?.oldestOverdueDays ? (
            <span className="self-start rounded-full border border-destructive/20 bg-background px-3 py-1.5 text-xs font-semibold text-destructive sm:self-auto">
              Mais antiga há {summary.oldestOverdueDays} {summary.oldestOverdueDays === 1 ? 'dia' : 'dias'}
            </span>
          ) : null}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo financeiro">
        <SummaryCard
          icon={CalendarClock}
          label="Próximo vencimento"
          value={summary?.nextDueDate ? currencyFormatter.format(Number(summary.nextDueAmount)) : 'Sem cobrança'}
          detail={summary?.nextDueDate ? formatDate(summary.nextDueDate) : 'Nenhuma fatura futura'}
        />
        <SummaryCard
          icon={Clock3}
          label="Em aberto"
          value={currencyFormatter.format(openAmount)}
          detail={`${openCount} ${openCount === 1 ? 'fatura' : 'faturas'}`}
        />
        <SummaryCard
          icon={AlertTriangle}
          label="Em atraso"
          value={currencyFormatter.format(overdueAmount)}
          detail={`${overdueCount} ${overdueCount === 1 ? 'fatura vencida' : 'faturas vencidas'}`}
          danger={overdueCount > 0}
        />
        <SummaryCard
          icon={CheckCircle2}
          label="Última atualização"
          value={effectiveLastSyncedAt ? format(parseISO(effectiveLastSyncedAt), 'HH:mm') : '—'}
          detail={formatDateTime(effectiveLastSyncedAt)}
        />
      </section>

      {(effectiveLastSyncError || linkQuery.isError || summaryQuery.isError || invoicesQuery.isError) && (
        <div className="rounded-lg border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-amber-900">
          Não foi possível atualizar todos os dados financeiros. As informações abaixo são a última cópia disponível.
        </div>
      )}

      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="border-b border-border bg-muted/15">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-primary" />
              Faturas da Plugue Guest
            </CardTitle>
            <span className="text-xs text-muted-foreground">Atualizado em {formatDateTime(effectiveLastSyncedAt)}</span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {sortedInvoices.length === 0 ? (
            <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
              <ReceiptText className="mb-3 h-7 w-7 text-muted-foreground/55" />
              <p className="text-sm font-medium">Nenhuma fatura encontrada</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Quando uma nova fatura for emitida, ela aparecerá aqui após a próxima sincronização.
              </p>
            </div>
          ) : (
            <>
              <div className="hidden lg:block">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[30%]">Descrição</TableHead>
                      <TableHead className="w-[13%]">Vencimento</TableHead>
                      <TableHead className="w-[11%]">Forma</TableHead>
                      <TableHead className="w-[14%]">Status</TableHead>
                      <TableHead className="w-[12%] text-right">Valor</TableHead>
                      <TableHead className="w-[20%] text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedInvoices.map((invoice) => {
                      const paymentUrl = toSafeExternalUrl(invoice.invoiceUrl) || toSafeExternalUrl(invoice.bankSlipUrl);
                      const canGeneratePix = effectiveLinkStatus === 'active'
                        && canGenerateBillingInvoicePix(invoice);
                      return (
                        <TableRow key={invoice.id}>
                          <TableCell>
                            <p className="truncate font-medium">{invoice.description || 'Mensalidade Plugue Guest'}</p>
                            {invoice.paymentDate && (
                              <p className="mt-0.5 text-xs text-muted-foreground">Pago em {formatDate(invoice.paymentDate)}</p>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap tabular-nums">{formatDate(invoice.dueDate)}</TableCell>
                          <TableCell>{billingTypeLabel(invoice.billingType)}</TableCell>
                          <TableCell><BillingStatusBadge status={invoice.status} /></TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {currencyFormatter.format(Number(invoice.value ?? 0))}
                          </TableCell>
                          <TableCell className="text-right">
                            {paymentUrl || canGeneratePix ? (
                              <div className="flex flex-wrap justify-end gap-1.5">
                                {paymentUrl && (
                                  <Button asChild variant="outline" size="sm" className="gap-1.5">
                                    <a href={paymentUrl} target="_blank" rel="noopener noreferrer">
                                      Abrir
                                      <ArrowUpRight className="h-3.5 w-3.5" />
                                    </a>
                                  </Button>
                                )}
                                {canGeneratePix && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="gap-1.5"
                                    onClick={() => handleOpenPix(invoice)}
                                  >
                                    <QrCode className="h-3.5 w-3.5" />
                                    Gerar Pix
                                  </Button>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">Indisponível</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <ul className="divide-y divide-border lg:hidden">
                {sortedInvoices.map((invoice) => {
                  const paymentUrl = toSafeExternalUrl(invoice.invoiceUrl) || toSafeExternalUrl(invoice.bankSlipUrl);
                  const canGeneratePix = effectiveLinkStatus === 'active'
                    && canGenerateBillingInvoicePix(invoice);
                  return (
                    <li key={invoice.id} className="space-y-4 p-4 sm:p-5">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="break-words text-sm font-semibold leading-snug [overflow-wrap:anywhere]">
                            {invoice.description || 'Mensalidade Plugue Guest'}
                          </h3>
                        </div>
                        <div className="shrink-0">
                          <BillingStatusBadge status={invoice.status} />
                        </div>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted/35 p-3">
                        <InvoiceDetail label="Vencimento" value={formatDate(invoice.dueDate)} tabular />
                        <InvoiceDetail
                          label="Valor"
                          value={currencyFormatter.format(Number(invoice.value ?? 0))}
                          valueClassName="font-semibold text-foreground"
                          tabular
                        />
                        <InvoiceDetail label="Forma" value={billingTypeLabel(invoice.billingType)} />
                        <InvoiceDetail label="Pagamento" value={formatDate(invoice.paymentDate)} tabular />
                      </dl>

                      {paymentUrl || canGeneratePix ? (
                        <div className={`grid gap-2 ${paymentUrl && canGeneratePix ? 'grid-cols-2' : 'grid-cols-1'}`}>
                          {paymentUrl && (
                            <Button asChild variant="outline" className="min-h-11 w-full gap-2 px-2">
                              <a href={paymentUrl} target="_blank" rel="noopener noreferrer">
                                Abrir fatura
                                <ArrowUpRight className="h-4 w-4" />
                              </a>
                            </Button>
                          )}
                          {canGeneratePix && (
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11 w-full gap-2 px-2"
                              onClick={() => handleOpenPix(invoice)}
                            >
                              <QrCode className="h-4 w-4" />
                              Gerar Pix
                            </Button>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed px-3 py-2.5 text-center text-xs text-muted-foreground">
                          Nenhuma ação disponível para esta fatura
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <InvoicePixDialog
        invoice={selectedPixInvoice}
        pixData={selectedPixData}
        error={selectedPixRequestMatches ? invoicePixQrCode.error : null}
        isExpired={invoicePixQrCode.expiredInvoiceId === selectedPixInvoice?.id}
        isLoading={selectedPixRequestMatches && invoicePixQrCode.isPending}
        open={!!selectedPixInvoice}
        onOpenChange={handlePixDialogOpenChange}
        onRetry={() => {
          if (selectedPixInvoice) requestInvoicePix(selectedPixInvoice);
        }}
      />

      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        Os pagamentos são processados pelo Asaas. Uma confirmação pode levar até quatro horas para aparecer neste painel.
      </p>
    </div>
  );
}

function PageHeader({ companyName }: { companyName: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        <WalletCards className="h-3.5 w-3.5" />
        Conta da unidade
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
      <p className="mt-1 text-sm text-muted-foreground">Plano e cobranças de {companyName}.</p>
    </div>
  );
}

function BillingPreviewBanner({
  globalEnabled,
  companyEnabled,
}: {
  globalEnabled: boolean;
  companyEnabled: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary-soft/60 px-5 py-4">
      <div className="mt-0.5 rounded-lg border border-primary/15 bg-background p-2 text-primary shadow-sm">
        <ShieldCheck className="h-4 w-4" />
      </div>
      <div>
        <p className="text-sm font-semibold text-foreground">Prévia exclusiva do superadmin</p>
        <p className="mt-1 text-sm leading-relaxed text-foreground/65">
          {!globalEnabled
            ? 'O Financeiro global está desativado. Você pode conferir o vínculo, sincronizar e revisar esta tela; os administradores da empresa ainda não veem o módulo.'
            : !companyEnabled
              ? 'O Financeiro desta empresa está desativado. A prévia e a sincronização manual continuam disponíveis somente para você; o admin da empresa não vê o módulo.'
              : 'Esta é uma prévia administrativa. Os dados continuam protegidos para os demais perfis.'}
        </p>
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  danger = false,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  detail: string;
  danger?: boolean;
}) {
  return (
    <Card className={danger ? 'border-destructive/25 shadow-sm' : 'shadow-sm'}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className={danger ? 'mt-2 truncate text-lg font-semibold tabular-nums text-destructive' : 'mt-2 truncate text-lg font-semibold tabular-nums'}>
              {value}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
          </div>
          <div className={danger ? 'rounded-lg bg-destructive-soft p-2 text-destructive' : 'rounded-lg bg-primary-soft p-2 text-primary'}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function InvoiceDetail({
  label,
  value,
  valueClassName = '',
  tabular = false,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  tabular?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-words text-sm ${tabular ? 'tabular-nums' : ''} ${valueClassName}`}>
        {value}
      </dd>
    </div>
  );
}

function CompanyBillingSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-lg" />)}
      </div>
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}
