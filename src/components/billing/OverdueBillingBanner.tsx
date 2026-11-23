import { useState } from 'react';
import { AlertTriangle, ArrowRight, X } from 'lucide-react';
import { Link } from 'react-router-dom';

interface OverdueBillingBannerProps {
  show: boolean;
  invoicesPath?: string;
  /** Empresa do aviso: dispensar vale só para ela e só até a sessão do navegador acabar. */
  dismissKey?: string;
}

const dismissStorageKey = (key: string) => `platform-billing:overdue-banner-dismissed:${key}`;

function readDismissed(key?: string) {
  if (!key) return false;
  try {
    return window.sessionStorage.getItem(dismissStorageKey(key)) === '1';
  } catch {
    return false;
  }
}

export default function OverdueBillingBanner({
  show,
  invoicesPath,
  dismissKey,
}: OverdueBillingBannerProps) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => (
    dismissKey && readDismissed(dismissKey) ? dismissKey : null
  ));
  const dismissed = !!dismissKey && (dismissedKey === dismissKey || readDismissed(dismissKey));

  if (!show || dismissed) return null;

  const handleDismiss = () => {
    if (!dismissKey) return;
    try {
      window.sessionStorage.setItem(dismissStorageKey(dismissKey), '1');
    } catch {
      // Sem armazenamento da sessão, o aviso some só até a próxima montagem.
    }
    setDismissedKey(dismissKey);
  };

  return (
    <section
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="shrink-0 min-w-0 border-b border-destructive/20 bg-destructive/[0.07] px-4 py-1.5 text-[hsl(0_55%_32%)]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <AlertTriangle
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-destructive"
        />
        <p className="min-w-0 flex-1 basis-64 text-sm leading-snug">
          <span className="font-semibold">Há faturas vencidas há 3 dias ou mais.</span>{' '}
          Regularize o pagamento para evitar a suspensão da conta.
        </p>

        {invoicesPath && (
          <Link
            to={invoicesPath}
            className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-1 text-sm font-semibold text-destructive underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            Ver faturas
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        )}

        {dismissKey && (
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dispensar o aviso até fechar o navegador"
            title="Dispensar até fechar o navegador"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>
    </section>
  );
}
