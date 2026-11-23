import { useEffect, useState } from 'react';
import QueryFeedback, { type FeedbackQuery } from '@/components/QueryFeedback';
import { Button } from '@/components/ui/button';
import type { ServiceTodayFreshness } from '@/lib/service-today';
import { cn } from '@/lib/utils';

/** The parallel service keeps routine refresh feedback in its fixed header. */
export default function ServiceQueryFeedback({ queries, timestampQueries = queries, onFreshnessChange, className }: {
  queries: FeedbackQuery[];
  timestampQueries?: FeedbackQuery[];
  onFreshnessChange?: (freshness: ServiceTodayFreshness) => void;
  className?: string;
}) {
  const [retrying, setRetrying] = useState(false);
  const fetching = retrying || queries.some(query => query.isFetching);
  const failed = queries.filter(query => query.isError);
  const timestampsKnown = timestampQueries.length > 0 && timestampQueries.every(query => query.data !== undefined && Number.isFinite(query.dataUpdatedAt) && query.dataUpdatedAt > 0);
  const updatedAt = timestampsKnown ? Math.min(...timestampQueries.map(query => query.dataUpdatedAt)) : null;
  const hasError = failed.length > 0;
  useEffect(() => {
    onFreshnessChange?.({ updatedAt, fetching, hasError });
  }, [onFreshnessChange, updatedAt, fetching, hasError]);

  // Standalone use of a copied screen retains its existing feedback contract.
  if (!onFreshnessChange) return <QueryFeedback queries={queries} className={className} />;
  if (!hasError) return null;
  const missing = failed.filter(query => query.data === undefined);
  const stale = failed.filter(query => query.data !== undefined);
  const retry = async () => {
    setRetrying(true);
    try { await Promise.allSettled(failed.map(query => Promise.resolve().then(() => query.refetch()))); }
    finally { setRetrying(false); }
  };
  return <div role="alert" className={cn('flex flex-wrap items-center gap-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs', className)}>
    <div className="min-w-0 space-y-1 text-destructive">
      {missing.length > 0 && <p>Não foi possível carregar {missing.map(query => query.label).join(', ')}.</p>}
      {stale.length > 0 && <p>Não foi possível atualizar {stale.map(query => query.label).join(', ')}. Mostrando os últimos dados disponíveis.</p>}
    </div>
    <Button type="button" variant="outline" size="sm" disabled={fetching} onClick={() => void retry()}>Tentar novamente</Button>
  </div>;
}
