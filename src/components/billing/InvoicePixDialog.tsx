import { useEffect, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, Check, Copy, Loader2, QrCode, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type {
  CompanyBillingInvoice,
  CompanyBillingInvoicePixQrCode,
} from '@/lib/platform-billing-contracts';
import {
  getCompanyBillingPixExpirationTimestamp,
  getCompanyBillingPixRemainingSeconds,
  isCompanyBillingPixQrCodeValid,
} from '@/lib/company-billing-pix-client';

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

function formatBillingDate(value: string | null | undefined) {
  if (!value) return '—';
  try {
    return format(parseISO(value), 'dd/MM/yyyy', { locale: ptBR });
  } catch {
    return '—';
  }
}

function formatPixExpiration(value: string | null | undefined) {
  if (!value) return '—';
  try {
    const normalizedValue = value.replace(' ', 'T');
    const pattern = /^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)
      ? 'dd/MM/yyyy'
      : "dd/MM/yyyy 'às' HH:mm";
    return format(parseISO(normalizedValue), pattern, { locale: ptBR });
  } catch {
    return '—';
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Não foi possível gerar o Pix desta fatura.';
}

async function copyTextToClipboard(value: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some browsers deny the async clipboard API even after a user action.
    }
  }

  if (typeof document !== 'undefined') {
    const textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.readOnly = true;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();

    try {
      if (typeof document.execCommand === 'function' && document.execCommand('copy')) return;
    } finally {
      document.body.removeChild(textArea);
    }
  }

  throw new Error('Clipboard unavailable');
}

interface InvoicePixDialogProps {
  invoice: CompanyBillingInvoice | null;
  pixData: CompanyBillingInvoicePixQrCode | null;
  error: unknown;
  isExpired?: boolean;
  isLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
}

export default function InvoicePixDialog({
  invoice,
  pixData,
  error,
  isExpired = false,
  isLoading,
  open,
  onOpenChange,
  onRetry,
}: InvoicePixDialogProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [liveMessage, setLiveMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const cooldownWasActive = useRef(false);
  const matchingPixData = invoice && pixData?.invoiceId === invoice.id ? pixData : null;
  const validPixData = isCompanyBillingPixQrCodeValid(matchingPixData, now)
    ? matchingPixData
    : null;
  const pixExpired = isExpired || (!!matchingPixData && !validPixData);
  const retryRemainingSeconds = getCompanyBillingPixRemainingSeconds(error, now);
  const cooldownActive = retryRemainingSeconds > 0;

  useEffect(() => {
    setCopyStatus('idle');
    setNow(Date.now());
    if (!open) return undefined;

    const updateClock = () => setNow(Date.now());
    const interval = window.setInterval(updateClock, 1000);
    const expirationTimestamp = getCompanyBillingPixExpirationTimestamp(
      matchingPixData?.expirationDate,
    );
    const expirationTimer = expirationTimestamp === null
      ? null
      : window.setTimeout(
        updateClock,
        Math.min(2_147_483_647, Math.max(0, expirationTimestamp - Date.now() + 1)),
      );

    return () => {
      window.clearInterval(interval);
      if (expirationTimer !== null) window.clearTimeout(expirationTimer);
    };
  }, [invoice?.id, matchingPixData?.expirationDate, open]);

  useEffect(() => {
    if (!open) {
      setLiveMessage('');
      return;
    }
    if (isLoading) {
      setLiveMessage('Gerando um Pix seguro. Isso pode levar alguns segundos.');
      return;
    }
    if (pixExpired) {
      setLiveMessage('Este código Pix expirou. Gere um novo código antes de realizar o pagamento.');
      return;
    }
    if (error) {
      setLiveMessage(`Não foi possível gerar o Pix. ${errorMessage(error)}`);
      return;
    }
    if (validPixData) {
      setLiveMessage(
        `Pix gerado com sucesso para a fatura com vencimento em ${formatBillingDate(validPixData.dueDate)}.`,
      );
      return;
    }
    setLiveMessage('');
  }, [error, isLoading, open, pixExpired, validPixData]);

  useEffect(() => {
    if (!open) {
      cooldownWasActive.current = false;
      return;
    }
    if (cooldownWasActive.current && !cooldownActive) {
      setLiveMessage('Nova tentativa disponível.');
    }
    cooldownWasActive.current = cooldownActive;
  }, [cooldownActive, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setCopyStatus('idle');
      setLiveMessage('');
    }
    onOpenChange(nextOpen);
  };

  const handleCopy = async () => {
    if (!validPixData?.payload) return;
    try {
      await copyTextToClipboard(validPixData.payload);
      setCopyStatus('copied');
      setLiveMessage('Código Pix copiado. Cole o código no aplicativo do seu banco.');
      toast.success('Código Pix copiado.');
    } catch {
      setCopyStatus('error');
      setLiveMessage('Não foi possível copiar. Selecione e copie o código manualmente.');
      toast.error('Não foi possível copiar. Selecione e copie o código manualmente.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        hideCloseButton
        aria-busy={isLoading}
        className="max-h-[calc(100dvh-1.5rem)] overflow-x-hidden overflow-y-auto overscroll-contain sm:max-h-[calc(100dvh-3rem)] sm:max-w-2xl"
      >
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 z-10 min-h-11 min-w-11 rounded-full"
            aria-label="Fechar pagamento via Pix"
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogClose>

        <DialogHeader className="pr-12">
          <DialogTitle className="flex items-center justify-center gap-2 sm:justify-start">
            <QrCode className="h-5 w-5 text-primary" />
            Pagar fatura via Pix
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {validPixData
              ? `Fatura com vencimento em ${formatBillingDate(validPixData.dueDate)}. Escaneie o QR Code ou copie o código abaixo.`
              : 'Escaneie o QR Code ou copie o código para pagar com segurança.'}
          </DialogDescription>
        </DialogHeader>

        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveMessage}
        </p>

        {isLoading && (
          <div
            className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 text-center"
          >
            <Loader2 className="mb-3 h-7 w-7 animate-spin text-primary" />
            <p className="text-sm font-semibold">Gerando um Pix seguro…</p>
            <p className="mt-1 text-xs text-muted-foreground">Isso pode levar alguns segundos.</p>
          </div>
        )}

        {!isLoading && (error || pixExpired) && (
          <div className="rounded-xl border border-destructive/25 bg-destructive-soft/45 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{pixExpired ? 'Este código Pix expirou' : 'Não foi possível gerar o Pix'}</p>
                <p className="mt-1 break-words text-sm leading-relaxed text-foreground/70">
                  {pixExpired
                    ? 'Gere um novo código antes de realizar o pagamento.'
                    : errorMessage(error)}
                </p>
              </div>
            </div>
            {retryRemainingSeconds > 0 && (
              <p className="mt-3 text-sm font-medium text-foreground/75">
                Nova tentativa disponível em {retryRemainingSeconds}s.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className="mt-4 min-h-11 w-full gap-2 sm:w-auto"
              onClick={onRetry}
              disabled={retryRemainingSeconds > 0}
            >
              <RefreshCw className="h-4 w-4" />
              {retryRemainingSeconds > 0
                ? `Aguarde ${retryRemainingSeconds}s`
                : 'Tentar novamente'}
            </Button>
          </div>
        )}

        {!isLoading && !error && validPixData && invoice && (
          <div className="grid min-w-0 gap-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <section
              className="flex flex-col items-center rounded-xl border bg-white p-4 text-center shadow-sm"
              aria-label="QR Code para pagamento via Pix"
            >
              <img
                src={`data:image/png;base64,${validPixData.encodedImage}`}
                alt={`QR Code Pix da fatura com vencimento em ${formatBillingDate(validPixData.dueDate)}`}
                width={224}
                height={224}
                className="h-auto w-full max-w-56"
                draggable={false}
              />
              <p className="mt-3 text-xs leading-relaxed text-slate-600">
                Aponte a câmera do aplicativo do seu banco.
              </p>
            </section>

            <div className="min-w-0 space-y-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-muted/35 p-4">
                <PixDetail
                  label="Valor"
                  value={currencyFormatter.format(validPixData.value)}
                  emphasized
                />
                <PixDetail label="Vencimento" value={formatBillingDate(validPixData.dueDate)} />
                <div className="col-span-2">
                  <PixDetail label="Validade do código" value={formatPixExpiration(validPixData.expirationDate)} />
                </div>
              </dl>

              <div className="space-y-2">
                <label htmlFor="invoice-pix-copy-code" className="text-sm font-medium">
                  Código Pix copia e cola
                </label>
                <Textarea
                  id="invoice-pix-copy-code"
                  value={validPixData.payload}
                  readOnly
                  rows={5}
                  wrap="soft"
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-h-28 resize-none whitespace-pre-wrap break-all font-mono text-xs leading-relaxed [overflow-wrap:anywhere]"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 w-full gap-2 sm:w-auto"
                  onClick={handleCopy}
                >
                  {copyStatus === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copyStatus === 'copied' ? 'Código copiado' : 'Copiar código Pix'}
                </Button>
                <p
                  className={`min-h-4 text-xs ${copyStatus === 'error' ? 'text-destructive' : 'text-success'}`}
                >
                  {copyStatus === 'copied'
                    ? 'Pronto! Cole o código no aplicativo do seu banco.'
                    : copyStatus === 'error'
                      ? 'Selecione o código acima e copie manualmente.'
                      : '\u00a0'}
                </p>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PixDetail({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-words tabular-nums ${emphasized ? 'text-lg font-semibold' : 'text-sm font-medium'}`}>
        {value}
      </dd>
    </div>
  );
}
