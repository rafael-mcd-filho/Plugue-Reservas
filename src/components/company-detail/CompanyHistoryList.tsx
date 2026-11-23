import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { CompanyHistoryItem } from './companyHistory';

const TONES: Record<CompanyHistoryItem['tagTone'], string> = {
  plain: 'bg-muted text-muted-foreground',
  support: 'bg-orange-100 text-orange-900',
  info: 'bg-info-soft text-info',
  brand: 'bg-primary-soft text-accent-foreground',
  success: 'bg-success-soft text-success',
};

export default function CompanyHistoryList({ items }: { items: CompanyHistoryItem[] }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
          <span className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">
            {format(new Date(item.createdAt), 'dd/MM/yyyy HH:mm')}
          </span>
          <span className="min-w-0 flex-1 basis-72 text-sm">{item.text}</span>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', TONES[item.tagTone])}>{item.tag}</span>
        </li>
      ))}
    </ul>
  );
}
