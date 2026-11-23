import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ListStateVariant = 'error' | 'empty' | 'no-results';

interface ListStateMessageProps {
  variant: ListStateVariant;
  title: string;
  description?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  className?: string;
}

const icons = { error: AlertTriangle, empty: Inbox, 'no-results': SearchX };

/**
 * Distingue falha de consulta, histórico vazio e filtro sem resultado.
 * Uma falha nunca deve aparecer como lista vazia.
 */
export default function ListStateMessage({
  variant,
  title,
  description,
  actionLabel,
  onAction,
  actionDisabled,
  className,
}: ListStateMessageProps) {
  const Icon = icons[variant];
  const isError = variant === 'error';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={cn(
        'flex min-h-48 flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        isError && 'text-destructive',
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn('h-7 w-7', isError ? 'text-destructive' : 'text-muted-foreground/50')} />
      <p className={cn('text-sm font-medium', !isError && 'text-foreground')}>{title}</p>
      {description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}
      {actionLabel && onAction && (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
