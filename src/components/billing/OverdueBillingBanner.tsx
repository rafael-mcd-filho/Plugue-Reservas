import { AlertTriangle, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

interface OverdueBillingBannerProps {
  show: boolean;
  invoicesPath?: string;
}

export default function OverdueBillingBanner({
  show,
  invoicesPath,
}: OverdueBillingBannerProps) {
  if (!show) return null;

  return (
    <section
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="shrink-0 min-w-0 bg-destructive px-4 py-2.5 text-destructive-foreground"
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-start gap-2.5 sm:items-center">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 sm:mt-0"
          />
          <p className="min-w-0 text-sm font-medium leading-snug">
            Há faturas vencidas há 6 dias ou mais. Regularize o pagamento para evitar a suspensão da conta.
          </p>
        </div>

        {invoicesPath && (
          <Link
            to={invoicesPath}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 self-start rounded-md border border-destructive-foreground/35 bg-destructive-foreground/10 px-3 text-sm font-semibold transition-colors hover:bg-destructive-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-destructive sm:min-h-9 sm:self-auto"
          >
            Ver faturas
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        )}
      </div>
    </section>
  );
}
