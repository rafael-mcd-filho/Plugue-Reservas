import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Download,
  Loader2,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { useSettlementPanelAccess } from '@/hooks/useSettlementPanelAccess';
import { paymentMessage } from '@/lib/payment-messages';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import {
  cancelWithdrawal,
  describePayoutDestination,
  downloadWithdrawalReceipt,
  formatSettlementMoney as money,
  formatSettlementTermsRates,
  getSettlementOverview,
  parseSettlementMoney,
  requestWithdrawal,
  savePayoutDestination,
  withdrawalStatusLabels,
  maskedPayoutDestination,
  settlementEntryLabel,
  type PayoutDestination,
  type SettlementOverview,
  type Withdrawal,
} from '@/lib/reservation-settlements-api';

const queryKey = (companyId: string, offset = 0) => [
  'reservation-settlements',
  companyId,
  offset,
];
const emptyDestination: PayoutDestination = {
  kind: 'pix',
  holder_name: '',
  holder_document: '',
  pix_key_type: 'cnpj',
  pix_key: '',
  bank_code: '',
  agency: '',
  account_number: '',
  account_type: 'checking',
};
const date = (value: string) => new Date(value).toLocaleString('pt-BR');
const message = (error: unknown) => paymentMessage(error instanceof Error ? error.message : error, 'Não foi possível concluir a operação.');

function FinancialQueryError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Saldo indisponível</AlertTitle>
      <AlertDescription>
        {message(error)} Os valores não podem ser consultados neste momento.
        <Button
          className="mt-3 block"
          size="sm"
          variant="outline"
          onClick={retry}
        >
          Tentar novamente
        </Button>
      </AlertDescription>
    </Alert>
  );
}
function Position({ overview }: { overview: SettlementOverview }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="mb-4 text-sm font-medium">
          Composição dos recebimentos elegíveis
        </p>
        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ['Recebimentos brutos', overview.gross_cents],
            ['Menos estornos', -overview.refunded_cents],
            ['Menos chargebacks', -overview.chargeback_cents],
            ['Menos intermediação', -overview.fee_cents],
            ['Líquido da empresa', overview.merchant_net_cents],
          ].map(([label, amount], index) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd
                className={`mt-2 text-lg font-semibold tabular-nums ${index === 4 ? 'text-success' : ''}`}
              >
                {money(Number(amount))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          O líquido considera as condições de cada cobrança. A liberação para
          saque segue a posição abaixo; repasses já realizados permanecem no
          histórico.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: 'Disponível para saque',
            amount: overview.available_cents,
            Icon: Wallet,
            active: true,
          },
          { label: 'A liberar', amount: overview.pending_cents, Icon: Clock3 },
          {
            label: 'Reservado em saques',
            amount: overview.reserved_cents,
            Icon: ArrowUpRight,
          },
          {
            label: 'Já repassado',
            amount: overview.paid_cents,
            Icon: CheckCircle2,
          },
        ].map(({ label, amount, Icon, active }) => (
          <div
            key={label}
            className={`rounded-xl border p-4 ${active ? 'border-success/30 bg-success-soft/40' : 'border-border bg-card'}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                {label}
              </span>
              <Icon
                className={`h-4 w-4 ${active ? 'text-success' : 'text-muted-foreground'}`}
              />
            </div>
            <p
              className={`mt-3 text-2xl font-semibold tabular-nums tracking-tight ${active ? 'text-success' : ''}`}
            >
              {money(amount)}
            </p>
          </div>
        ))}
      </div>
      {Number(overview.blocked_cents ?? 0) > 0 && (
        <Alert>
          <AlertTitle>
            Valores em conferência: {money(overview.blocked_cents ?? 0)}
          </AlertTitle>
          <AlertDescription>
            Estornos em processamento ou pendências de conciliação mantêm esses
            valores fora do saldo disponível.
          </AlertDescription>
        </Alert>
      )}
      {!!overview.attention_count && (
        <p className="text-xs text-muted-foreground">
          {overview.attention_count} cobrança(s) aguardando conferência
          financeira pela plataforma.
        </p>
      )}
      {overview.available_cents < 0 && (
        <Alert variant="destructive">
          <AlertTitle>
            {overview.blocked_cents > 0
              ? 'Saldo temporariamente comprometido'
              : 'Saldo a regularizar'}
          </AlertTitle>
          <AlertDescription>
            {overview.blocked_cents > 0
              ? 'Há valores em conferência além dos valores já reservados ou repassados. Aguarde a conciliação antes de solicitar novos saques.'
              : 'Devoluções ou ajustes superaram o saldo da empresa. Novos recebimentos compensarão essa diferença antes de novos saques.'}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm font-medium">
            Intermediação:{' '}
            {overview.terms
              ? formatSettlementTermsRates(overview.terms)
              : 'a definir'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            As tarifas de processamento estão incluídas na intermediação. Cada cobrança
            preserva a taxa contratada.
          </p>
        </div>
        {overview.terms && (
          <p className="max-w-sm text-xs text-muted-foreground">
            {overview.terms.release_policy === 'after_reservation'
              ? 'Liberação após a liquidação do pagamento e a data da reserva.'
              : 'Liberação após a liquidação do pagamento.'}
            {overview.terms.hold_days > 0 &&
              ` Prazo adicional: ${overview.terms.hold_days} dia(s).`}
          </p>
        )}
      </div>
      {!overview.terms?.enabled && (
        <Alert>
          <AlertTitle>Novas cobranças ainda não habilitadas</AlertTitle>
          <AlertDescription>
            A plataforma precisa definir e ativar as condições comerciais antes
            de receber novos pagamentos antecipados. Cobranças, saldos e
            pedidos de saque já existentes continuam preservados.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function CompanySettlementBalance({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: queryKey(companyId),
    queryFn: () => getSettlementOverview(companyId),
    enabled: !!companyId,
    retry: false,
  });
  return (
    <Card className="border-primary/15">
      <CardHeader>
        <CardTitle className="text-base">Saldo e repasses</CardTitle>
        <CardDescription>
          Posição acumulada da empresa, independente do filtro de período das
          cobranças.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Consultando saldo…
          </p>
        ) : query.isError ? (
          <FinancialQueryError
            error={query.error}
            retry={() => query.refetch()}
          />
        ) : (
          <Position overview={query.data} />
        )}
      </CardContent>
    </Card>
  );
}

function DestinationFields({
  value,
  setValue,
}: {
  value: PayoutDestination;
  setValue: (value: PayoutDestination) => void;
}) {
  const update = (key: keyof PayoutDestination, text: string) =>
    setValue({ ...value, [key]: text });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="payout-holder">Nome do titular</Label>
          <Input
            id="payout-holder"
            value={value.holder_name}
            onChange={(e) => update('holder_name', e.target.value)}
            autoComplete="organization"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="payout-document">CPF ou CNPJ do titular</Label>
          <Input
            id="payout-document"
            inputMode="numeric"
            value={value.holder_document}
            onChange={(e) => update('holder_document', e.target.value)}
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="payout-kind">Forma de recebimento</Label>
        <Select
          value={value.kind}
          onValueChange={(kind) =>
            setValue({ ...value, kind: kind as 'pix' | 'bank' })
          }
        >
          <SelectTrigger id="payout-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pix">Pix</SelectItem>
            <SelectItem value="bank">Conta bancária</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {value.kind === 'pix' ? (
        <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
          <div className="space-y-2">
            <Label htmlFor="payout-pix-type">Tipo de chave</Label>
            <Select
              value={value.pix_key_type ?? 'cnpj'}
              onValueChange={(type) => update('pix_key_type', type)}
            >
              <SelectTrigger id="payout-pix-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  ['cnpj', 'CNPJ'],
                  ['cpf', 'CPF'],
                  ['email', 'E-mail'],
                  ['phone', 'Telefone'],
                  ['random', 'Aleatória'],
                ].map(([type, label]) => (
                  <SelectItem key={type} value={type}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="payout-pix">Chave Pix</Label>
            <Input
              id="payout-pix"
              value={value.pix_key ?? ''}
              onChange={(e) => update('pix_key', e.target.value)}
              required
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="payout-bank">Código do banco</Label>
            <Input
              id="payout-bank"
              value={value.bank_code ?? ''}
              onChange={(e) => update('bank_code', e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payout-agency">Agência</Label>
            <Input
              id="payout-agency"
              value={value.agency ?? value.branch ?? ''}
              onChange={(e) => update('agency', e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payout-account">Conta com dígito</Label>
            <Input
              id="payout-account"
              value={value.account_number ?? ''}
              onChange={(e) => update('account_number', e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payout-account-type">Tipo de conta</Label>
            <Select
              value={value.account_type ?? 'checking'}
              onValueChange={(type) => update('account_type', type)}
            >
              <SelectTrigger id="payout-account-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="checking">Corrente</SelectItem>
                <SelectItem value="savings">Poupança</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CompanySettlements({
  companyId,
  showOverview = true,
}: {
  companyId: string;
  showOverview?: boolean;
}) {
  const { canRead, canWrite, isLoading: accessLoading } = useSettlementPanelAccess(companyId);
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: queryKey(companyId, offset),
    queryFn: () => getSettlementOverview(companyId, offset),
    enabled: !!companyId && canRead,
    retry: false,
  });
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [destination, setDestination] = useState<PayoutDestination>({
    ...emptyDestination,
  });
  const [requestOpen, setRequestOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [requestKey, setRequestKey] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Withdrawal | null>(null);
  const [localError, setLocalError] = useState('');
  const overview = query.data;
  const amountCents = parseSettlementMoney(amount);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ['reservation-settlements', companyId],
    });
  useEffect(() => {
    if (overview?.destination && !destinationOpen)
      setDestination(overview.destination);
  }, [overview?.destination, destinationOpen]);
  const saveDestination = useMutation({
    mutationFn: () => savePayoutDestination(companyId, destination),
    onSuccess: async () => {
      setDestinationOpen(false);
      toast.success('Destino de pagamento salvo.');
      await refresh();
    },
    onError: (error) => setLocalError(message(error)),
  });
  const request = useMutation({
    mutationFn: () => requestWithdrawal(companyId, amountCents!, requestKey),
    onSuccess: async () => {
      setRequestOpen(false);
      setAmount('');
      toast.success('Saque solicitado. O valor foi reservado.');
      await refresh();
    },
    onError: async (error) => {
      setLocalError(message(error));
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelWithdrawal(companyId, cancelTarget!.id),
    onSuccess: async () => {
      setCancelTarget(null);
      toast.success('Pedido cancelado e saldo liberado.');
      await refresh();
    },
    onError: (error) => toast.error(message(error)),
  });
  const receipt = useMutation({
    mutationFn: (withdrawal: Withdrawal) =>
      downloadWithdrawalReceipt(companyId, withdrawal.id),
    onSuccess: (result) =>
      window.open(result.signed_url, '_blank', 'noopener,noreferrer'),
    onError: (error) => toast.error(message(error)),
  });
  const validRequest =
    !!amountCents &&
    !!overview &&
    amountCents <= overview.available_cents &&
    !!overview.destination;
  if (accessLoading) return <p role="status" className="text-sm text-muted-foreground">Verificando acesso financeiro…</p>;
  if (!canRead) return (
    <Alert>
      <AlertTitle>Acesso aos saques</AlertTitle>
      <AlertDescription>Entre com o administrador da empresa para consultar os pedidos, dados de pagamento e comprovantes.</AlertDescription>
    </Alert>
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Seus repasses
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Solicite o valor disponível e acompanhe o pagamento e o comprovante
            por aqui.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Atualizar saldo
          </Button>
          <Button
            size="sm"
            disabled={
              !canWrite ||
              !overview?.destination ||
              !(overview.available_cents > 0) ||
              query.isError
            }
            onClick={() => {
              setAmount('');
              setRequestKey(crypto.randomUUID());
              setConfirming(false);
              setLocalError('');
              setRequestOpen(true);
            }}
          >
            <ArrowDownToLine className="mr-2 h-4 w-4" />
            Solicitar saque
          </Button>
        </div>
      </div>
      {!canWrite && (
        <Alert>
          <AlertTitle>Acesso para consulta</AlertTitle>
          <AlertDescription>
            Somente um administrador da empresa, em sua própria sessão, pode
            alterar o destino e solicitar ou cancelar saques.
          </AlertDescription>
        </Alert>
      )}
      {query.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Consultando saldo…
        </p>
      ) : query.isError ? (
        <FinancialQueryError
          error={query.error}
          retry={() => query.refetch()}
        />
      ) : (
        <>
          {showOverview && <Position overview={overview} />}
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  Destino do pagamento
                </CardTitle>
                <CardDescription>
                  O destino é preservado em cada pedido de saque.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite}
                onClick={() => {
                  setDestination(
                    overview.destination ?? { ...emptyDestination },
                  );
                  setLocalError('');
                  setDestinationOpen(true);
                }}
              >
                {overview.destination ? 'Alterar destino' : 'Cadastrar destino'}
              </Button>
            </CardHeader>
            <CardContent>
              {overview.destination ? (
                <>
                  <p className="text-sm font-medium">
                    {overview.destination.holder_name}
                  </p>
                  <p className="mt-1 break-all text-sm text-muted-foreground">
                    {describePayoutDestination(overview.destination)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Cadastre uma chave Pix ou uma conta bancária para solicitar
                  seu primeiro saque.
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Histórico de saques</CardTitle>
              <CardDescription>
                O saldo é reservado no pedido e só vira repasse após o
                pagamento.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {overview.withdrawals.length === 0 ? (
                <p className="py-5 text-center text-sm text-muted-foreground">
                  Nenhum pedido de saque neste período.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="pb-3 pr-4 font-medium">Pedido</th>
                        <th className="pb-3 pr-4 font-medium">Valor</th>
                        <th className="pb-3 pr-4 font-medium">Situação</th>
                        <th className="pb-3 text-right font-medium">Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.withdrawals.map((withdrawal) => (
                        <tr
                          key={withdrawal.id}
                          className="border-b last:border-0"
                        >
                          <td className="py-4 pr-4">
                            <p className="font-medium">
                              #{withdrawal.id.slice(0, 8)}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {maskedPayoutDestination(
                                withdrawal.destination_snapshot,
                              )}
                            </p>
                            <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                              {date(withdrawal.created_at)}
                            </p>
                            {withdrawal.reason && (
                              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                                {withdrawal.reason}
                              </p>
                            )}
                          </td>
                          <td className="whitespace-nowrap py-4 pr-4 font-medium tabular-nums">
                            {money(withdrawal.amount_cents)}
                          </td>
                          <td className="py-4 pr-4">
                            <Badge
                              variant={
                                withdrawal.status === 'paid'
                                  ? 'default'
                                  : 'secondary'
                              }
                            >
                              {withdrawalStatusLabels[withdrawal.status]}
                            </Badge>
                            {withdrawal.paid_at && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {date(withdrawal.paid_at)}
                              </p>
                            )}
                          </td>
                          <td className="py-4 text-right">
                            {withdrawal.receipt_path && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={receipt.isPending}
                                onClick={() => receipt.mutate(withdrawal)}
                              >
                                <Download className="mr-2 h-4 w-4" />
                                Comprovante
                              </Button>
                            )}
                            {canWrite &&
                              ['requested', 'under_review'].includes(
                                withdrawal.status,
                              ) && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setCancelTarget(withdrawal)}
                                >
                                  Cancelar pedido
                                </Button>
                              )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Extrato de movimentações
              </CardTitle>
              <CardDescription>
                Entradas, liberações e saques registrados, sem alterar o
                histórico.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {overview.ledger.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  As movimentações aparecerão após os primeiros recebimentos
                  elegíveis.
                </p>
              ) : (
                <div className="space-y-3">
                  {overview.ledger.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex justify-between gap-4 border-b pb-3 text-sm last:border-0"
                    >
                      <div>
                        <p className="font-medium">
                          {entry.description ?? settlementEntryLabel(entry)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {date(entry.created_at)}
                        </p>
                      </div>
                      <div className="text-right text-xs tabular-nums">
                        <p>Disponível: {money(entry.available_delta_cents)}</p>
                        <p className="mt-1 text-muted-foreground">
                          A liberar: {money(entry.pending_delta_cents)}
                        </p>
                        {!!entry.blocked_delta_cents && (
                          <p className="mt-1 text-muted-foreground">
                            Em conferência: {money(entry.blocked_delta_cents)}
                          </p>
                        )}
                        {!!entry.reserved_delta_cents && (
                          <p className="mt-1 text-muted-foreground">
                            Reservado: {money(entry.reserved_delta_cents)}
                          </p>
                        )}
                        {!!entry.paid_delta_cents && (
                          <p className="mt-1 text-muted-foreground">
                            Repassado: {money(entry.paid_delta_cents)}
                          </p>
                        )}
                        {!!entry.fee_delta_cents && (
                          <p className="mt-1 text-muted-foreground">
                            Intermediação: {money(entry.fee_delta_cents)}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="text-xs text-muted-foreground">
              Página {offset / 25 + 1}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - 25))}
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={
                offset + 25 >=
                Math.max(overview.withdrawal_count, overview.ledger_count)
              }
              onClick={() => setOffset((value) => value + 25)}
            >
              Próxima
            </Button>
          </div>
        </>
      )}
      <Dialog
        open={destinationOpen}
        onOpenChange={(open) => {
          if (!saveDestination.isPending) setDestinationOpen(open);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setLocalError('');
              saveDestination.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Destino para seus repasses</DialogTitle>
              <DialogDescription>
                Confira a titularidade e todos os dados. A alteração vale para
                pedidos feitos depois de salvar.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5">
              <DestinationFields
                value={destination}
                setValue={setDestination}
              />
            </div>
            {localError && (
              <p role="alert" className="mb-4 text-sm text-destructive">
                {localError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saveDestination.isPending}
                onClick={() => setDestinationOpen(false)}
              >
                Voltar
              </Button>
              <Button type="submit" disabled={saveDestination.isPending}>
                {saveDestination.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Salvar destino
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={requestOpen}
        onOpenChange={(open) => {
          if (!request.isPending) setRequestOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirming ? 'Confirmar pedido de saque' : 'Solicitar saque'}
            </DialogTitle>
            <DialogDescription>
              {confirming
                ? 'Confira o valor e o destino antes de reservar o saldo.'
                : `Disponível neste momento: ${money(overview?.available_cents ?? 0)}.`}
            </DialogDescription>
          </DialogHeader>
          {confirming ? (
            <div className="space-y-4 py-4">
              <p className="text-3xl font-semibold tabular-nums">
                {money(amountCents ?? 0)}
              </p>
              <div className="rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  {overview?.destination?.holder_name}
                </p>
                <p className="mt-1 break-all text-muted-foreground">
                  {overview?.destination &&
                    describePayoutDestination(overview.destination)}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                O valor ficará reservado até o pagamento ou cancelamento. Você
                poderá acompanhar a análise nesta tela.
              </p>
            </div>
          ) : (
            <div className="space-y-2 py-4">
              <Label htmlFor="withdrawal-amount">Valor do saque (R$)</Label>
              <Input
                id="withdrawal-amount"
                inputMode="decimal"
                placeholder="0,00"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setLocalError('');
                }}
              />
              {amount && !validRequest && (
                <p role="alert" className="text-sm text-destructive">
                  Informe um valor positivo, com até duas casas decimais, dentro
                  do saldo disponível.
                </p>
              )}
            </div>
          )}
          {localError && (
            <p role="alert" className="text-sm text-destructive">
              {localError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={request.isPending}
              onClick={() =>
                confirming ? setConfirming(false) : setRequestOpen(false)
              }
            >
              Voltar
            </Button>
            <Button
              disabled={!validRequest || request.isPending}
              onClick={() => {
                setLocalError('');
                if (confirming) request.mutate();
                else setConfirming(true);
              }}
            >
              {request.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {confirming ? 'Confirmar solicitação' : 'Conferir pedido'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!cancelTarget}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) setCancelTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar pedido de saque?</DialogTitle>
            <DialogDescription>
              O valor de {money(cancelTarget?.amount_cents ?? 0)} será devolvido
              ao saldo disponível. Pedidos em pagamento não podem ser cancelados
              por aqui.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => setCancelTarget(null)}
            >
              Manter pedido
            </Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Confirmar cancelamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
