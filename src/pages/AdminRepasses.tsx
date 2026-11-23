import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  Loader2,
  MinusCircle,
  RefreshCw,
  Send,
  Settings2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import ListPagination from '@/components/admin/ListPagination';
import ListStateMessage from '@/components/admin/ListStateMessage';
import { fetchPendingWithdrawals } from '@/hooks/useAdminSettlements';
import SettlementTermsDialog from '@/components/billing/SettlementTermsDialog';
import { Textarea } from '@/components/ui/textarea';
import {
  describePayoutDestination,
  downloadWithdrawalReceipt,
  formatSettlementMoney as money,
  formatSettlementTermsRates,
  getAdminSettlementOverview,
  transitionWithdrawal,
  uploadWithdrawalReceipt,
  withdrawalStatusLabels,
  type Withdrawal,
  type WithdrawalStatus,
} from '@/lib/reservation-settlements-api';

function localDateTime(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
}
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Não foi possível concluir a operação.';

type RepassesView = 'all' | 'queue' | 'balances';
export type QueueSegment = 'pending' | 'processing' | 'all';
const QUEUE_PAGE_SIZE = 25;
const COMPANY_PAGE_SIZE = 25;

const withdrawalPresentation: Record<WithdrawalStatus, { icon: typeof Clock3; className: string; action: string }> = {
  requested: { icon: Clock3, className: 'border-warning/30 bg-warning-soft text-amber-900', action: 'Analisar' },
  under_review: { icon: Eye, className: 'border-info/25 bg-info-soft text-info', action: 'Continuar análise' },
  processing: { icon: Send, className: 'border-info/25 bg-info-soft text-info', action: 'Registrar pagamento' },
  paid: { icon: CheckCircle2, className: 'border-success/25 bg-success-soft text-success', action: 'Ver pedido' },
  rejected: { icon: XCircle, className: 'border-destructive/25 bg-destructive-soft text-destructive', action: 'Ver pedido' },
  cancelled: { icon: MinusCircle, className: 'border-border bg-muted text-muted-foreground', action: 'Ver pedido' },
};

function WithdrawalStatusBadge({ status }: { status: WithdrawalStatus }) {
  const presentation = withdrawalPresentation[status];
  const Icon = presentation.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${presentation.className}`}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {withdrawalStatusLabels[status]}
    </span>
  );
}

function requestAge(createdAt: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return '—';
  return formatDistanceToNowStrict(date, { addSuffix: true, locale: ptBR });
}

export default function AdminRepasses({
  view = 'all',
  initialSegment = 'pending',
}: { view?: RepassesView; initialSegment?: QueueSegment }) {
  const queryClient = useQueryClient();
  const showQueue = view !== 'balances';
  const showBalances = view !== 'queue';
  const [segment, setSegment] = useState<QueueSegment>(initialSegment);
  const [status, setStatus] = useState('all');
  const [offset, setOffset] = useState(0);
  const [companyOffset, setCompanyOffset] = useState(0);
  const queueQuery = useQuery({
    queryKey: ['admin-reservation-settlements', 'queue', segment, status, offset],
    queryFn: async () => {
      if (segment === 'pending') {
        const pending = await fetchPendingWithdrawals();
        return { withdrawals: pending.withdrawals, total: pending.total, complete: pending.complete };
      }
      const result = await getAdminSettlementOverview(
        segment === 'processing' ? 'processing' : status,
        offset,
        0,
        { limit: QUEUE_PAGE_SIZE, companyLimit: 1 },
      );
      return { withdrawals: result.withdrawals, total: result.total, complete: true };
    },
    enabled: showQueue,
    retry: false,
  });
  const companiesQuery = useQuery({
    queryKey: ['admin-reservation-settlements', 'companies', companyOffset],
    queryFn: () => getAdminSettlementOverview('all', 0, companyOffset, { limit: 1, companyLimit: COMPANY_PAGE_SIZE }),
    enabled: showBalances,
    retry: false,
  });
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsCompanyId, setTermsCompanyId] = useState('');
  const [selected, setSelected] = useState<Withdrawal | null>(null);
  const [action, setAction] = useState<WithdrawalStatus | ''>('');
  const [reason, setReason] = useState('');
  const [bankReference, setBankReference] = useState('');
  const [paidAt, setPaidAt] = useState(localDateTime);
  const [file, setFile] = useState<File | null>(null);
  const [receiptPath, setReceiptPath] = useState('');
  const [formError, setFormError] = useState('');
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['admin-reservation-settlements'],
      }),
      queryClient.invalidateQueries({ queryKey: ['reservation-settlements'] }),
    ]);
  };
  const transition = useMutation({
    mutationFn: async () => {
      let path = receiptPath;
      if (action === 'paid' && !path) {
        if (!file)
          throw new Error(
            'Anexe o comprovante antes de confirmar o pagamento.',
          );
        path = (await uploadWithdrawalReceipt(selected!.id, file)).receipt_path;
        setReceiptPath(path);
      }
      return transitionWithdrawal(selected!.id, action as WithdrawalStatus, {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(action === 'paid'
          ? {
              receipt_path: path,
              bank_reference: bankReference.trim(),
              paid_at: new Date(paidAt).toISOString(),
            }
          : {}),
      });
    },
    onSuccess: async () => {
      setSelected(null);
      toast.success('Pedido atualizado.');
      await invalidate();
    },
    onError: async (error) => {
      setFormError(errorMessage(error));
      await invalidate();
    },
  });
  const download = useMutation({
    mutationFn: (withdrawal: Withdrawal) =>
      downloadWithdrawalReceipt(withdrawal.company_id, withdrawal.id),
    onSuccess: (result) =>
      window.open(result.signed_url, '_blank', 'noopener,noreferrer'),
    onError: (error) => toast.error(errorMessage(error)),
  });
  function openWithdrawal(withdrawal: Withdrawal) {
    setSelected(withdrawal);
    setAction('');
    setReason('');
    setBankReference('');
    setPaidAt(localDateTime());
    setFile(null);
    setReceiptPath('');
    setFormError('');
  }
  const proofFileValid =
    !file ||
    (file.size > 0 &&
      file.size <= 5 * 1024 * 1024 &&
      ['application/pdf', 'image/png', 'image/jpeg'].includes(file.type));
  const proofValid =
    !!(file || receiptPath) &&
    proofFileValid &&
    !!bankReference.trim() &&
    Number.isFinite(Date.parse(paidAt)) &&
    Date.parse(paidAt) <= Date.now() &&
    Date.parse(paidAt) >= Date.parse(selected?.created_at ?? '');
  const canConfirm =
    !!action &&
    (action !== 'paid' || proofValid) &&
    (action !== 'rejected' || reason.trim().length >= 3);
  const queueWithdrawals = queueQuery.data?.withdrawals ?? [];
  const companyRows = companiesQuery.data?.companies ?? [];
  const companyName = (withdrawal: Withdrawal) =>
    withdrawal.company_name
    ?? companyRows.find((row) => row.id === withdrawal.company_id)?.name
    ?? 'Empresa';
  const segments: Array<{ id: QueueSegment; label: string }> = [
    { id: 'pending', label: 'Pendentes' },
    { id: 'processing', label: 'Em pagamento' },
    { id: 'all', label: 'Todos os pedidos' },
  ];
  return (
    <div className="space-y-5">
      {showQueue && (
        <div className="space-y-3">
          <ol aria-label="Como funciona um repasse" className="flex flex-wrap gap-2 text-xs">
            {['Analisar o pedido', 'Pagar pelo banco, fora do sistema', 'Registrar o pagamento e anexar o comprovante'].map((step, index) => (
              <li key={step} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
                <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-soft font-semibold text-accent-foreground">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-border bg-muted/15">
              <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
                <div>
                  <CardTitle className="text-base">Pedidos de saque</CardTitle>
                  <CardDescription>
                    O valor fica reservado no saldo da empresa até o pedido ser pago, recusado ou cancelado.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div role="group" aria-label="Situação dos pedidos" className="flex rounded-lg bg-muted p-1">
                    {segments.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={segment === item.id}
                        onClick={() => {
                          setSegment(item.id);
                          setOffset(0);
                        }}
                        className={
                          segment === item.id
                            ? 'rounded-md bg-card px-3 py-1.5 text-sm font-semibold shadow-sm'
                            : 'rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground'
                        }
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  {segment === 'all' && (
                    <div className="w-full sm:w-48">
                      <Label htmlFor="withdrawal-status-filter" className="sr-only">
                        Filtrar situação
                      </Label>
                      <Select
                        value={status}
                        onValueChange={(value) => {
                          setStatus(value);
                          setOffset(0);
                        }}
                      >
                        <SelectTrigger id="withdrawal-status-filter">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Todas as situações</SelectItem>
                          {Object.entries(withdrawalStatusLabels).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={queueQuery.isFetching}
                    onClick={() => void queueQuery.refetch()}
                    className="gap-2"
                  >
                    <RefreshCw className={queueQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                    Atualizar
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {queueQuery.isPending ? (
                <div role="status" className="space-y-3 p-5">
                  <span className="sr-only">Consultando pedidos…</span>
                  {[1, 2, 3].map((item) => <Skeleton key={item} className="h-12 w-full" />)}
                </div>
              ) : queueQuery.isError ? (
                <ListStateMessage
                  variant="error"
                  title="Não foi possível consultar os pedidos de saque"
                  description={errorMessage(queueQuery.error)}
                  actionLabel="Tentar novamente"
                  onAction={() => void queueQuery.refetch()}
                />
              ) : queueWithdrawals.length === 0 ? (
                <ListStateMessage
                  variant="empty"
                  title={segment === 'pending' ? 'Nenhum pedido aguardando análise' : 'Nenhum pedido encontrado'}
                  description={segment === 'pending' ? 'Quando uma empresa pedir um saque, ele aparece aqui.' : 'Altere a situação para ver outros pedidos.'}
                />
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Empresa e pedido</TableHead>
                          <TableHead>{segment === 'all' ? 'Solicitado em' : 'Pedido'}</TableHead>
                          <TableHead className="text-right">Valor</TableHead>
                          <TableHead>Situação</TableHead>
                          <TableHead className="text-right">Próxima ação</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {queueWithdrawals.map((withdrawal) => (
                          <TableRow key={withdrawal.id}>
                            <TableCell>
                              <p className="font-medium">{companyName(withdrawal)}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">#{withdrawal.id.slice(0, 8)}</p>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-sm">
                              {segment === 'all'
                                ? new Date(withdrawal.created_at).toLocaleString('pt-BR')
                                : requestAge(withdrawal.created_at)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                              {money(withdrawal.amount_cents)}
                            </TableCell>
                            <TableCell>
                              <WithdrawalStatusBadge status={withdrawal.status} />
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant={['requested', 'under_review', 'processing'].includes(withdrawal.status) ? 'default' : 'outline'}
                                onClick={() => openWithdrawal(withdrawal)}
                              >
                                {withdrawalPresentation[withdrawal.status].action}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {segment === 'pending' ? (
                    <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                      {queueQuery.data?.complete
                        ? `${queueWithdrawals.length} ${queueWithdrawals.length === 1 ? 'pedido pendente' : 'pedidos pendentes'}, do mais antigo para o mais novo.`
                        : `Mostrando os ${queueWithdrawals.length} pedidos mais recentes de ${queueQuery.data?.total ?? 0}. Use "Todos os pedidos" para ver o restante.`}
                    </p>
                  ) : (
                    <ListPagination
                      page={Math.floor(offset / QUEUE_PAGE_SIZE) + 1}
                      pageSize={QUEUE_PAGE_SIZE}
                      total={queueQuery.data?.total ?? 0}
                      onPageChange={(nextPage) => setOffset((nextPage - 1) * QUEUE_PAGE_SIZE)}
                      itemLabel={['pedido', 'pedidos']}
                      disabled={queueQuery.isFetching}
                      className="border-t border-border"
                    />
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {showBalances && (
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border bg-muted/15">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle className="text-base">Saldos por empresa</CardTitle>
                <CardDescription>
                  Posição de cada empresa. A tarifa do Asaas é custo da plataforma e sai da intermediação.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={companiesQuery.isFetching}
                  onClick={() => void companiesQuery.refetch()}
                  className="gap-2"
                >
                  <RefreshCw className={companiesQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  Atualizar
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!companiesQuery.data}
                  onClick={() => {
                    setTermsCompanyId('');
                    setTermsOpen(true);
                  }}
                  className="gap-2"
                >
                  <Settings2 className="h-4 w-4" />
                  Taxas por empresa
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {companiesQuery.isPending ? (
              <div role="status" className="space-y-3 p-5">
                <span className="sr-only">Consultando saldos…</span>
                {[1, 2, 3].map((item) => <Skeleton key={item} className="h-12 w-full" />)}
              </div>
            ) : companiesQuery.isError ? (
              <ListStateMessage
                variant="error"
                title="Não foi possível consultar os saldos"
                description={errorMessage(companiesQuery.error)}
                actionLabel="Tentar novamente"
                onAction={() => void companiesQuery.refetch()}
              />
            ) : companyRows.length === 0 ? (
              <ListStateMessage variant="empty" title="Nenhuma empresa cadastrada" />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Empresa</TableHead>
                        <TableHead>Taxas</TableHead>
                        <TableHead>Liberação</TableHead>
                        <TableHead className="text-right">Disponível</TableHead>
                        <TableHead className="text-right">A liberar</TableHead>
                        <TableHead className="text-right">Em conferência</TableHead>
                        <TableHead className="text-right">Reservado em saques</TableHead>
                        <TableHead className="text-right">Ações</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {companyRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <p className="font-medium">{row.name}</p>
                            <p className={row.terms?.enabled ? 'mt-0.5 text-xs text-success' : 'mt-0.5 text-xs text-muted-foreground'}>
                              {row.terms
                                ? row.terms.enabled ? 'Cobranças novas habilitadas' : 'Cobranças novas desabilitadas'
                                : 'Taxa ainda não definida'}
                            </p>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {row.terms ? formatSettlementTermsRates(row.terms) : '—'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {row.terms
                              ? `${row.terms.release_policy === 'on_settlement' ? 'Na compensação' : 'Após a reserva'}${row.terms.hold_days > 0 ? ` + ${row.terms.hold_days} ${row.terms.hold_days === 1 ? 'dia' : 'dias'}` : ''}`
                              : '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                            {money(row.available_cents)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                            {money(row.pending_cents)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                            {money(row.blocked_cents ?? 0)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                            {money(row.reserved_cents)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setTermsCompanyId(row.id);
                                setTermsOpen(true);
                              }}
                            >
                              Configurar
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <ListPagination
                  page={Math.floor(companyOffset / COMPANY_PAGE_SIZE) + 1}
                  pageSize={COMPANY_PAGE_SIZE}
                  total={companiesQuery.data?.company_count ?? companyRows.length}
                  onPageChange={(nextPage) => setCompanyOffset((nextPage - 1) * COMPANY_PAGE_SIZE)}
                  itemLabel={['empresa', 'empresas']}
                  disabled={companiesQuery.isFetching}
                  className="border-t border-border"
                />
              </>
            )}
          </CardContent>
        </Card>
      )}
      <SettlementTermsDialog
        open={termsOpen}
        onOpenChange={setTermsOpen}
        companies={companyRows}
        companyId={termsCompanyId}
        onCompanyChange={setTermsCompanyId}
        onSaved={invalidate}
      />
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !transition.isPending) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Pedido #{selected?.id.slice(0, 8)}</DialogTitle>
            <DialogDescription>
              {selected ? companyName(selected) : ''}{' '}
              · {selected && withdrawalStatusLabels[selected.status]}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="space-y-5">
              <p className="text-3xl font-semibold tabular-nums tracking-tight">
                {money(selected.amount_cents)}
              </p>
              <div className="rounded-lg border bg-muted/20 p-4 text-sm">
                <p className="font-medium">
                  {selected.destination_snapshot.holder_name}
                </p>
                <p className="mt-1 text-muted-foreground">
                  CPF/CNPJ: {selected.destination_snapshot.holder_document}
                </p>
                <p className="mt-2 break-all">
                  {describePayoutDestination(selected.destination_snapshot)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Destino registrado na solicitação. Alterações posteriores no
                  cadastro não modificam este pedido.
                </p>
              </div>
              {selected.reason && (
                <p className="text-sm text-muted-foreground">
                  Motivo: {selected.reason}
                </p>
              )}
              {selected.receipt_path && (
                <Button
                  variant="outline"
                  disabled={download.isPending}
                  onClick={() => download.mutate(selected)}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Baixar comprovante
                </Button>
              )}
              {selected.status === 'processing' && (
                <Alert>
                  <AlertTitle>Pagamento manual em andamento</AlertTitle>
                  <AlertDescription>
                    Confira se a transferência foi realizada antes de concluir.
                    Uma dúvida ou falha de comunicação não libera o saldo
                    reservado.
                  </AlertDescription>
                </Alert>
              )}
              {!action && (
                <div className="flex flex-wrap gap-2">
                  {selected.status === 'requested' && (
                    <Button
                      variant="outline"
                      onClick={() => setAction('under_review')}
                    >
                      Iniciar análise
                    </Button>
                  )}
                  {selected.status === 'under_review' && (
                    <Button onClick={() => setAction('processing')}>
                      Iniciar pagamento
                    </Button>
                  )}
                  {['requested', 'under_review'].includes(selected.status) && (
                    <Button
                      variant="destructive"
                      onClick={() => setAction('rejected')}
                    >
                      Recusar pedido
                    </Button>
                  )}
                  {selected.status === 'processing' && (
                    <Button
                      onClick={() => {
                        setPaidAt(localDateTime());
                        setAction('paid');
                      }}
                    >
                      Registrar pagamento realizado
                    </Button>
                  )}
                </div>
              )}
              {action === 'processing' && (
                <Alert>
                  <AlertTitle>Assumir este pagamento?</AlertTitle>
                  <AlertDescription>
                    O pedido ficará em pagamento. Realize a transferência para o
                    destino acima e depois anexe o comprovante para concluir.
                  </AlertDescription>
                </Alert>
              )}
              {action === 'under_review' && (
                <p className="text-sm">
                  O pedido será marcado como em análise e continuará com o valor
                  reservado.
                </p>
              )}
              {action === 'rejected' && (
                <div className="space-y-2">
                  <Label htmlFor="withdrawal-reason">Motivo da recusa</Label>
                  <Textarea
                    id="withdrawal-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Explique o motivo para a empresa"
                  />
                  <p className="text-xs text-muted-foreground">
                    O valor reservado voltará ao saldo disponível.
                  </p>
                </div>
              )}
              {action === 'paid' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="withdrawal-proof">
                      Comprovante do pagamento
                    </Label>
                    <Input
                      id="withdrawal-proof"
                      type="file"
                      accept="application/pdf,image/png,image/jpeg"
                      onChange={(event) => {
                        setFile(event.target.files?.[0] ?? null);
                        setReceiptPath('');
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      PDF, PNG ou JPEG, até 5 MB. Acesso privado para a empresa
                      e superadmin.
                    </p>
                    {!proofFileValid && (
                      <p role="alert" className="text-sm text-destructive">
                        Selecione PDF, PNG ou JPEG de até 5 MB.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="withdrawal-bank-reference">
                      Referência da transferência
                    </Label>
                    <Input
                      id="withdrawal-bank-reference"
                      value={bankReference}
                      onChange={(event) => setBankReference(event.target.value)}
                      placeholder="ID ou autenticação da transferência"
                    />
                    <p className="text-xs text-muted-foreground">
                      Use o identificador único da transferência, como o E2E do
                      Pix ou a autenticação bancária. A mesma transferência não
                      pode quitar dois pedidos.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="withdrawal-paid-at">
                      Data e hora do pagamento
                    </Label>
                    <Input
                      id="withdrawal-paid-at"
                      type="datetime-local"
                      step="1"
                      value={paidAt}
                      max={localDateTime()}
                      onChange={(event) => setPaidAt(event.target.value)}
                    />
                  </div>
                </div>
              )}
              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={transition.isPending}
                  onClick={() => (action ? setAction('') : setSelected(null))}
                >
                  Voltar
                </Button>
                {action && (
                  <Button
                    disabled={!canConfirm || transition.isPending}
                    onClick={() => {
                      setFormError('');
                      transition.mutate();
                    }}
                  >
                    {transition.isPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {action === 'paid'
                      ? 'Confirmar pagamento'
                      : action === 'rejected'
                        ? 'Confirmar recusa'
                        : 'Confirmar alteração'}
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
