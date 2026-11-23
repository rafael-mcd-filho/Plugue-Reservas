import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface FeedbackQuery {
  label: string;
  data: unknown;
  isPending?: boolean;
  isLoading?: boolean;
  isFetching: boolean;
  isError: boolean;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
}

/** Pass only enabled queries. Undefined means unknown; empty arrays and null are loaded results. */
export default function QueryFeedback({ queries, className }: { queries: FeedbackQuery[]; className?: string }) {
  const [retrying, setRetrying] = useState(false);
  if (queries.length === 0) return null;

  const failed = queries.filter((query) => query.isError);
  const missing = failed.filter((query) => query.data === undefined);
  const stale = failed.filter((query) => query.data !== undefined);
  const fetching = retrying || queries.some((query) => query.isFetching);
  const waiting = queries.some((query) => query.data === undefined && !query.isError && (query.isPending || query.isLoading));
  const hasData = queries.some((query) => query.data !== undefined);
  const timestampsKnown = queries.every((query) => query.data !== undefined && Number.isFinite(query.dataUpdatedAt) && query.dataUpdatedAt > 0);
  const updatedAt = timestampsKnown ? Math.min(...queries.map((query) => query.dataUpdatedAt)) : null;

  const retry = async () => {
    setRetrying(true);
    try {
      await Promise.allSettled(queries.filter((query) => query.isError).map((query) => Promise.resolve().then(() => query.refetch())));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      role={failed.length > 0 ? 'alert' : 'status'}
      aria-live="polite"
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', failed.length > 0 && 'rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2', className)}
    >
      <div className="min-w-0 space-y-1">
        {missing.length > 0 && <p className="text-destructive">Não foi possível carregar {missing.map((query) => query.label).join(', ')}.</p>}
        {stale.length > 0 && <p className="text-destructive">Não foi possível atualizar {stale.map((query) => query.label).join(', ')}. Mostrando os últimos dados disponíveis.</p>}
        {updatedAt !== null && <p>Última atualização: {new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(updatedAt)}</p>}
        {fetching && <p className="inline-flex items-center gap-1"><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />{hasData ? 'Atualizando…' : 'Carregando…'}</p>}
        {!fetching && waiting && <p>Aguardando carregamento…</p>}
      </div>
      {failed.length > 0 && <Button type="button" variant="outline" size="sm" disabled={fetching} onClick={retry}>Tentar novamente</Button>}
    </div>
  );
}
