import { useEffect, useMemo, useState, type ReactNode, type SVGProps } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock3, Copy, CreditCard, ExternalLink, Loader2, QrCode, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Progress } from '@/components/ui/progress';
import {
  checkReservationPayment,
  getReservationPayment,
  selectReservationPaymentMethod,
} from '@/lib/asaas-prepayment-api';
import {
  formatPrepaymentAmount,
  getPaymentStatusLabel,
  type PublicReservationPaymentSummary,
  type ReservationPaymentStatus,
  type ReservationPrepaymentBillingType,
} from '@/lib/asaas-prepayment-contracts';
import { toBrazilWhatsAppNumber } from '@/lib/validation';

function WhatsAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M12 2.25a9.75 9.75 0 0 0-8.35 14.78L2.3 21.7l4.84-1.27A9.75 9.75 0 1 0 12 2.25Z"
      />
      <path
        fill="white"
        d="M9.25 6.65c-.23 0-.45.11-.63.31-.31.33-.82.83-.82 1.94s.81 2.18.92 2.33c.11.14 1.58 2.52 3.83 3.44 1.87.75 2.25.6 2.66.56.41-.04 1.32-.54 1.51-1.06.19-.53.19-.97.13-1.06-.05-.09-.19-.15-.39-.25-.2-.1-1.16-.57-1.34-.64-.18-.06-.31-.09-.45.12-.13.2-.52.63-.63.77-.12.13-.24.15-.43.05-.2-.1-.84-.31-1.6-1-.59-.53-.99-1.19-1.12-1.39-.12-.2-.02-.3.09-.4.09-.09.2-.23.3-.34.1-.11.13-.2.2-.32.07-.13.03-.25-.01-.34-.05-.1-.44-1.12-.61-1.53-.16-.39-.33-.4-.45-.4h-.38Z"
      />
    </svg>
  );
}

function buildHelpWhatsappUrl(payment: PublicReservationPaymentSummary) {
  const whatsappNumber = toBrazilWhatsAppNumber(payment.company.whatsapp);
  if (!whatsappNumber) return null;

  const formattedDate = formatReservationDate(payment.reservation.date, payment.reservation.time);
  const message =
    `Ola! Preciso de ajuda com o pagamento da minha reserva em ${payment.company.name}.\n` +
    `Data: ${formattedDate}\n` +
    `Cliente: ${payment.reservation.guest_name}`;

  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
}

function buildNewReservationUrl(payment: PublicReservationPaymentSummary) {
  return payment.company.slug ? `/${payment.company.slug}` : '/';
}

function buildReservationTrackingUrl(payment: PublicReservationPaymentSummary) {
  if (!payment.company.slug || !payment.reservation.public_tracking_code) return null;
  return `/${payment.company.slug}/reserva/${payment.reservation.public_tracking_code}`;
}

const PAID_REDIRECT_DELAY_SECONDS = 10;

function onlyDigits(value: string) {
  return value.replace(/\D/g, '');
}

function maskCpfCnpj(value: string) {
  const digits = onlyDigits(value).slice(0, 14);
  if (digits.length <= 11) {
    return digits
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1-$2');
  }
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

function isValidCpfCnpj(value: string) {
  const digits = onlyDigits(value);
  return digits.length === 11 || digits.length === 14;
}

const DEFAULT_DEADLINE_SECONDS = 10 * 60;

function formatReservationDate(date: string, time: string) {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year} às ${time.slice(0, 5)}`;
}

function getRemainingSeconds(expiresAt: string | null | undefined, now: number) {
  if (!expiresAt) return 0;
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, Math.floor((expiresAtMs - now) / 1000));
}

function formatRemainingTime(seconds: number) {
  if (seconds <= 0) return 'Esgotado';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function getStatusView(status: ReservationPaymentStatus) {
  if (status === 'paid') {
    return {
      icon: CheckCircle2,
      title: 'Reserva confirmada',
      description: 'Pagamento recebido. Sua reserva está confirmada.',
      color: 'text-success',
      barClassName: 'bg-success',
    };
  }

  if (status === 'expired') {
    return {
      icon: XCircle,
      title: 'Pré-reserva expirada',
      description: 'O prazo de pagamento terminou e a mesa foi liberada para novas reservas.',
      color: 'text-muted-foreground',
      barClassName: 'bg-muted-foreground/40',
    };
  }

  if (status === 'cancelled') {
    return {
      icon: XCircle,
      title: 'Pagamento cancelado',
      description: 'O link desta pré-reserva foi cancelado.',
      color: 'text-destructive',
      barClassName: 'bg-destructive',
    };
  }

  if (status === 'refunded') {
    return {
      icon: XCircle,
      title: 'Pagamento estornado',
      description: 'O pagamento desta reserva foi estornado pelo provedor.',
      color: 'text-destructive',
      barClassName: 'bg-destructive',
    };
  }

  if (status === 'partial_refunded') {
    return {
      icon: XCircle,
      title: 'Pagamento parcialmente estornado',
      description: 'Parte do pagamento desta reserva foi estornada pelo provedor.',
      color: 'text-destructive',
      barClassName: 'bg-destructive',
    };
  }

  if (status === 'refund_pending') {
    return {
      icon: RefreshCw,
      title: 'Estorno em processamento',
      description: 'O estorno foi solicitado e aguarda confirmação do provedor.',
      color: 'text-warning',
      barClassName: 'bg-warning',
    };
  }

  if (status === 'refund_denied') {
    return {
      icon: AlertCircle,
      title: 'Estorno negado',
      description: 'O provedor negou o estorno deste pagamento.',
      color: 'text-destructive',
      barClassName: 'bg-destructive',
    };
  }

  if (status === 'chargeback') {
    return {
      icon: AlertCircle,
      title: 'Pagamento em chargeback',
      description: 'O pagamento desta reserva entrou em disputa no provedor.',
      color: 'text-destructive',
      barClassName: 'bg-destructive',
    };
  }

  if (status === 'late_paid') {
    return {
      icon: AlertCircle,
      title: 'Pagamento em análise',
      description: 'O pagamento foi detectado depois do prazo. Nossa equipe vai validar a disponibilidade da mesa.',
      color: 'text-warning',
      barClassName: 'bg-warning',
    };
  }

  if (status === 'failed') {
    return {
      icon: AlertCircle,
      title: 'Não foi possível processar',
      description: 'Houve uma falha ao processar o pagamento. Entre em contato com a equipe do restaurante.',
      color: 'text-destructive',
      barClassName: 'bg-destructive',
    };
  }

  if (status === 'awaiting_method') {
    return {
      icon: Clock3,
      title: 'Escolha a forma de pagamento',
      description: 'Selecione Pix ou cartão para abrir o checkout seguro.',
      color: 'text-primary',
      barClassName: 'bg-primary',
    };
  }

  return {
    icon: Clock3,
    title: 'Aguardando pagamento',
    description: 'Finalize o pagamento dentro do prazo para confirmar a reserva.',
    color: 'text-primary',
    barClassName: 'bg-primary',
  };
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  return now;
}

export default function PublicReservationPayment() {
  const { paymentToken = '' } = useParams<{ paymentToken: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['reservation-payment', paymentToken] as const, [paymentToken]);

  const paymentQuery = useQuery({
    queryKey,
    queryFn: () => getReservationPayment(paymentToken),
    enabled: Boolean(paymentToken),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'awaiting_method' ? 5000 : false;
    },
  });

  const payment = paymentQuery.data;
  const showPaymentActions = payment?.status === 'pending' || payment?.status === 'awaiting_method';
  const now = useNow(Boolean(showPaymentActions));
  const remainingSeconds = payment ? getRemainingSeconds(payment.expires_at, now) : 0;
  const progress = showPaymentActions
    ? Math.min(100, Math.max(0, (remainingSeconds / DEFAULT_DEADLINE_SECONDS) * 100))
    : payment?.status === 'paid'
      ? 100
      : 0;

  const [pixCpfDialogOpen, setPixCpfDialogOpen] = useState(false);
  const [pixCpfValue, setPixCpfValue] = useState('');
  const [selectingBillingType, setSelectingBillingType] =
    useState<ReservationPrepaymentBillingType | undefined>(undefined);

  const selectMethodMutation = useMutation({
    mutationFn: ({ billingType, cpf }: { billingType: ReservationPrepaymentBillingType; cpf?: string }) =>
      selectReservationPaymentMethod(paymentToken, billingType, cpf ? { cpf } : undefined),
    retry: false,
  });

  const handlePaymentMethodSuccess = (updatedPayment: PublicReservationPaymentSummary) => {
    queryClient.setQueryData(queryKey, updatedPayment);
    setPixCpfDialogOpen(false);
    if (updatedPayment.billing_type === 'PIX' && updatedPayment.pix_qr_code_base64) {
      toast.success('Pix gerado, escaneie o QR Code ou copie o código abaixo.');
      return;
    }
    if (updatedPayment.payment_link_url) {
      window.location.assign(updatedPayment.payment_link_url);
      return;
    }
    toast.success('Pagamento preparado.');
  };

  const submitPaymentMethod = async ({
    billingType,
    cpf,
  }: {
    billingType: ReservationPrepaymentBillingType;
    cpf?: string;
  }) => {
    setSelectingBillingType(billingType);

    try {
      const updatedPayment = await selectMethodMutation.mutateAsync({ billingType, cpf });
      handlePaymentMethodSuccess(updatedPayment);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível criar o pagamento.');
    } finally {
      setSelectingBillingType(undefined);
      selectMethodMutation.reset();
    }
  };

  const activeSelectingBillingType = selectMethodMutation.isPending ? selectingBillingType : undefined;

  const checkPaymentMutation = useMutation({
    mutationFn: () => checkReservationPayment(paymentToken),
    onSuccess: (updatedPayment) => {
      queryClient.setQueryData(queryKey, updatedPayment);
      if (updatedPayment.confirmation?.status === 'paid' || updatedPayment.status === 'paid') {
        toast.success('Pagamento confirmado. Sua reserva foi confirmada.');
        return;
      }
      if (updatedPayment.status === 'expired') {
        toast.info('O prazo desta pré-reserva expirou.');
        return;
      }
      if (updatedPayment.message) {
        toast.info(updatedPayment.message);
        return;
      }
      toast.info('Pagamento ainda não confirmado.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Não foi possível consultar o pagamento.');
    },
  });

  const isExpiredTimer = Boolean(showPaymentActions && payment && remainingSeconds <= 0);
  useEffect(() => {
    if (!isExpiredTimer) return;
    if (checkPaymentMutation.isPending) return;
    checkPaymentMutation.mutate();
  }, [isExpiredTimer, checkPaymentMutation]);

  const trackingUrl = payment ? buildReservationTrackingUrl(payment) : null;
  const isPaid = payment?.status === 'paid';
  const [paidCountdown, setPaidCountdown] = useState(PAID_REDIRECT_DELAY_SECONDS);

  useEffect(() => {
    if (!isPaid || !trackingUrl) {
      setPaidCountdown(PAID_REDIRECT_DELAY_SECONDS);
      return undefined;
    }

    setPaidCountdown(PAID_REDIRECT_DELAY_SECONDS);
    const interval = window.setInterval(() => {
      setPaidCountdown((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval);
          navigate(trackingUrl);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isPaid, trackingUrl, navigate]);

  const handleSelectMethod = (billingType: ReservationPrepaymentBillingType) => {
    if (billingType === 'PIX') {
      setPixCpfValue('');
      setPixCpfDialogOpen(true);
      return;
    }
    void submitPaymentMethod({ billingType });
  };

  const handleConfirmPixCpf = () => {
    const digits = onlyDigits(pixCpfValue);
    if (!isValidCpfCnpj(digits)) {
      toast.error('Informe um CPF ou CNPJ válido.');
      return;
    }
    void submitPaymentMethod({ billingType: 'PIX', cpf: digits });
  };

  if (!paymentToken) {
    return <PaymentPageShell errorTitle="Link inválido" errorMessage="O token do pagamento não foi informado." />;
  }

  if (paymentQuery.isLoading) {
    return (
      <PaymentPageShell>
        <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-border bg-card">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">Carregando pagamento da reserva...</p>
          </div>
        </div>
      </PaymentPageShell>
    );
  }

  if (paymentQuery.error || !payment) {
    return (
      <PaymentPageShell
        errorTitle="Pagamento não encontrado"
        errorMessage={paymentQuery.error instanceof Error ? paymentQuery.error.message : 'Não foi possível carregar este pagamento.'}
        onRetry={() => paymentQuery.refetch()}
      />
    );
  }

  const statusView = getStatusView(payment.status);
  const StatusIcon = statusView.icon;

  return (
    <PaymentPageShell>
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <main className="space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pagamento da reserva</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Esta página mantém as opções da sua pré-reserva. Se fechar o navegador ou trocar de aparelho, volte por este link para acompanhar o pagamento.
            </p>
          </div>

          <Card className="overflow-hidden border-border shadow-card">
            <div className={`h-1.5 ${statusView.barClassName}`} />
            <CardContent className="space-y-6 p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-primary/10 p-3">
                    <StatusIcon className={`h-6 w-6 ${statusView.color}`} />
                  </div>
                  <div>
                    <h2 className={`text-lg font-semibold ${statusView.color}`}>{statusView.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{statusView.description}</p>
                  </div>
                </div>
                <Badge variant={payment.status === 'paid' ? 'default' : 'secondary'}>
                  {getPaymentStatusLabel(payment.status)}
                </Badge>
              </div>

              {showPaymentActions && (
                <div className="space-y-3 rounded-lg border border-border bg-background p-4">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground">Tempo restante</span>
                    <span className="font-medium text-foreground">{formatRemainingTime(remainingSeconds)}</span>
                  </div>
                  <Progress value={progress} />
                  <p className="text-xs text-muted-foreground">
                    Quando o prazo terminar, o link será removido e a mesa será liberada.
                  </p>
                </div>
              )}

              {showPaymentActions && remainingSeconds > 0 && (
                <PaymentActionArea
                  payment={payment}
                  checking={checkPaymentMutation.isPending}
                  selectingBillingType={activeSelectingBillingType}
                  onSelectMethod={handleSelectMethod}
                  onOpenPaymentLink={() => handleOpenPaymentLink(payment)}
                  onCheckPayment={() => checkPaymentMutation.mutate()}
                />
              )}

              {showPaymentActions && remainingSeconds <= 0 && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Prazo expirado</AlertTitle>
                  <AlertDescription>
                    O tempo para concluir esta pré-reserva acabou. A mesa foi liberada — inicie uma nova reserva para tentar novamente.
                  </AlertDescription>
                </Alert>
              )}

              {!showPaymentActions && payment.status !== 'paid' && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Pagamento encerrado</AlertTitle>
                  <AlertDescription>
                    Esta pré-reserva não aceita mais pagamento por este link. Inicie uma nova reserva ou fale com o restaurante.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </main>

        <PaymentSummary payment={payment} paidCountdown={isPaid ? paidCountdown : null} trackingUrl={trackingUrl} />
      </div>

      <PixCpfDialog
        open={pixCpfDialogOpen}
        value={pixCpfValue}
        loading={activeSelectingBillingType === 'PIX'}
        onChange={setPixCpfValue}
        onCancel={() => setPixCpfDialogOpen(false)}
        onConfirm={handleConfirmPixCpf}
      />
    </PaymentPageShell>
  );
}

function PixCpfDialog({
  open,
  value,
  loading,
  onChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Informe seu CPF ou CNPJ</DialogTitle>
          <DialogDescription>
            O CPF/CNPJ é obrigatório no Pix para identificar o pagador. Não cobramos nada extra.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="pix-cpf-input">CPF ou CNPJ</Label>
            <Input
              id="pix-cpf-input"
              autoFocus
              inputMode="numeric"
              placeholder="000.000.000-00"
              value={maskCpfCnpj(value)}
              onChange={(event) => onChange(event.target.value)}
              maxLength={18}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
              Cancelar
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Gerar Pix
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function handleOpenPaymentLink(payment: PublicReservationPaymentSummary) {
  if (!payment.payment_link_url) {
    toast.error('Link de pagamento indisponível.');
    return;
  }
  window.open(payment.payment_link_url, '_blank', 'noopener,noreferrer');
}

function PaymentActionArea({
  payment,
  checking,
  selectingBillingType,
  onSelectMethod,
  onOpenPaymentLink,
  onCheckPayment,
}: {
  payment: PublicReservationPaymentSummary;
  checking: boolean;
  selectingBillingType: ReservationPrepaymentBillingType | undefined;
  onSelectMethod: (billingType: ReservationPrepaymentBillingType) => void;
  onOpenPaymentLink: () => void;
  onCheckPayment: () => void;
}) {
  const showPixEmbedded =
    payment.status === 'pending' && payment.billing_type === 'PIX' && payment.pix_qr_code_base64;

  if (showPixEmbedded) {
    return (
      <PixEmbeddedView payment={payment} checking={checking} onCheckPayment={onCheckPayment} />
    );
  }

  return (
    <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-background p-5 text-center">
        <div className="rounded-full bg-primary/10 p-4">
          <ShieldCheck className="h-8 w-8 text-primary" />
        </div>
        <div>
          <p className="font-medium text-foreground">Pagamento seguro</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Pix é exibido aqui na hora. O cartão abre em um ambiente protegido para concluir a cobrança.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-sm text-muted-foreground">Valor do sinal</p>
          <p className="text-3xl font-semibold text-foreground">{formatPrepaymentAmount(payment.base_amount)}</p>
          {payment.customer_notice && <p className="mt-1 text-sm text-muted-foreground">{payment.customer_notice}</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {payment.pix_amount && (
            <PaymentMethodBox
              icon="pix"
              title="Pix"
              amount={payment.pix_amount}
              description="Gera QR Code e código copia-cola na hora."
              disabled={payment.status === 'pending' || Boolean(selectingBillingType)}
              loading={selectingBillingType === 'PIX'}
              selected={payment.billing_type === 'PIX'}
              onSelect={() => onSelectMethod('PIX')}
            />
          )}
          {payment.credit_card_amount && (
            <PaymentMethodBox
              icon="card"
              title="Cartão"
              amount={payment.credit_card_amount}
              description={`Em até ${payment.max_credit_card_installments ?? 1}x no cartão.`}
              disabled={payment.status === 'pending' || Boolean(selectingBillingType)}
              loading={selectingBillingType === 'CREDIT_CARD'}
              selected={payment.billing_type === 'CREDIT_CARD'}
              onSelect={() => onSelectMethod('CREDIT_CARD')}
            />
          )}
        </div>

        {payment.status === 'pending' && payment.billing_type === 'CREDIT_CARD' && (
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex flex-col gap-2">
              <Button onClick={onOpenPaymentLink} disabled={!payment.payment_link_url} className="w-full">
                <ExternalLink className="mr-2 h-4 w-4" />
                Abrir pagamento do cartão
              </Button>
              <Button variant="outline" onClick={onCheckPayment} disabled={checking} className="w-full">
                {checking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Já paguei
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PixEmbeddedView({
  payment,
  checking,
  onCheckPayment,
}: {
  payment: PublicReservationPaymentSummary;
  checking: boolean;
  onCheckPayment: () => void;
}) {
  const copyCode = async () => {
    if (!payment.pix_copy_paste) return;
    try {
      await navigator.clipboard.writeText(payment.pix_copy_paste);
      toast.success('Código Pix copiado.');
    } catch {
      toast.error('Não foi possível copiar. Selecione e copie manualmente.');
    }
  };

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-white p-4 text-center">
        {payment.pix_qr_code_base64 ? (
          <img
            src={`data:image/png;base64,${payment.pix_qr_code_base64}`}
            alt="QR Code Pix"
            className="h-56 w-56"
          />
        ) : (
          <div className="flex h-56 w-56 items-center justify-center rounded-md border border-dashed border-border bg-muted">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        <p className="text-xs text-muted-foreground">Escaneie pelo app do seu banco</p>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-sm text-muted-foreground">Valor a pagar</p>
          <p className="text-3xl font-semibold text-foreground">
            {formatPrepaymentAmount(payment.amount ?? payment.pix_amount ?? payment.base_amount)}
          </p>
          {payment.customer_notice && (
            <p className="mt-1 text-sm text-muted-foreground">{payment.customer_notice}</p>
          )}
        </div>

        {payment.pix_copy_paste && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Código Pix copia e cola</p>
            <div className="rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground break-all">
              {payment.pix_copy_paste}
            </div>
            <Button onClick={copyCode} variant="outline" className="w-full sm:w-auto">
              <Copy className="mr-2 h-4 w-4" />
              Copiar código Pix
            </Button>
          </div>
        )}

        <div className="rounded-lg border border-border bg-background p-3">
          <Button variant="outline" onClick={onCheckPayment} disabled={checking} className="w-full">
            {checking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Já paguei
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Após o pagamento, a confirmação aparece aqui automaticamente em alguns segundos.
          </p>
        </div>
      </div>
    </div>
  );
}

function PaymentMethodBox({
  icon,
  title,
  amount,
  description,
  disabled,
  loading,
  selected,
  onSelect,
}: {
  icon: 'pix' | 'card';
  title: string;
  amount: number;
  description: string;
  disabled: boolean;
  loading: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = icon === 'pix' ? QrCode : CreditCard;

  return (
    <div className={`rounded-lg border bg-background p-3 ${selected ? 'border-primary/50' : 'border-border'}`}>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon className="h-4 w-4 text-primary" />
        {title}
        {selected && <Badge variant="secondary">Selecionado</Badge>}
      </div>
      <p className="text-xl font-semibold text-foreground">{formatPrepaymentAmount(amount)}</p>
      <p className="mt-1 min-h-8 text-xs text-muted-foreground">{description}</p>
      <Button variant="outline" size="sm" className="mt-3 w-full" disabled={disabled} onClick={onSelect}>
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Escolher {title}
      </Button>
    </div>
  );
}

function PaymentSummary({
  payment,
  paidCountdown,
  trackingUrl,
}: {
  payment: PublicReservationPaymentSummary;
  paidCountdown: number | null;
  trackingUrl: string | null;
}) {
  const helpWhatsappUrl = buildHelpWhatsappUrl(payment);
  const newReservationUrl = buildNewReservationUrl(payment);
  const isPaid = payment.status === 'paid';

  return (
    <aside className="space-y-4">
      <Card className="border-border shadow-card">
        <CardContent className="space-y-4 p-5">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Reserva</p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">{payment.company.name}</h2>
          </div>
          <div className="space-y-3 text-sm">
            <SummaryLine label="Cliente" value={payment.reservation.guest_name} />
            <SummaryLine label="Data" value={formatReservationDate(payment.reservation.date, payment.reservation.time)} />
            <SummaryLine label="Pessoas" value={String(payment.reservation.party_size)} />
          </div>
        </CardContent>
      </Card>

      {isPaid && trackingUrl ? (
        <Card className="border-border shadow-card">
          <CardContent className="space-y-3 p-5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Acompanhe sua reserva</p>
            <p>
              Vamos te redirecionar para a página de acompanhamento em <strong>{paidCountdown ?? 0}s</strong>. Você pode acompanhar e gerenciar sua reserva por lá.
            </p>
            <Button asChild className="w-full">
              <Link to={trackingUrl}>Ir agora</Link>
            </Button>
          </CardContent>
        </Card>
      ) : !isPaid ? (
        <Card className="border-border shadow-card">
          <CardContent className="space-y-3 p-5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Política</p>
            <p>{payment.cancellation_policy || 'Consulte o restaurante para detalhes da política desta reserva.'}</p>
            {helpWhatsappUrl && (
              <Button asChild className="w-full bg-emerald-600 text-white hover:bg-emerald-700">
                <a href={helpWhatsappUrl} target="_blank" rel="noopener noreferrer">
                  <WhatsAppIcon className="mr-2 h-4 w-4" />
                  Falar pelo WhatsApp
                </a>
              </Button>
            )}
            <Button asChild variant="outline" className="w-full">
              <Link to={newReservationUrl}>Iniciar nova reserva</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </aside>
  );
}

function PaymentPageShell({
  children,
  errorTitle,
  errorMessage,
  onRetry,
}: {
  children?: ReactNode;
  errorTitle?: string;
  errorMessage?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="min-h-screen bg-secondary px-4 py-6 text-foreground sm:py-10">
      {children || (
        <div className="mx-auto max-w-xl">
          <Alert className="border-destructive/30">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <AlertTitle>{errorTitle}</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
          <div className="mt-4 flex gap-2">
            {onRetry && (
              <Button variant="outline" onClick={onRetry}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Tentar novamente
              </Button>
            )}
            <Button asChild variant="outline">
              <Link to="/">Iniciar nova reserva</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[190px] truncate text-right font-medium text-foreground">{value}</span>
    </div>
  );
}
