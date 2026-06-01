import { useState } from 'react';
import { CheckCheck, ChevronLeft, ChevronRight, Info, AlertTriangle, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCompanyNotifications, useMarkNotificationsRead } from '@/hooks/useSettings';

interface NotificationBannerProps {
  companyId: string;
}

const TYPE_CONFIG = {
  info:    { icon: Info,           headerClass: 'bg-blue-50 border-blue-200 dark:bg-blue-950/40 dark:border-blue-800',    iconClass: 'text-blue-500' },
  warning: { icon: AlertTriangle,  headerClass: 'bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-800', iconClass: 'text-amber-500' },
  success: { icon: CheckCircle2,   headerClass: 'bg-green-50 border-green-200 dark:bg-green-950/40 dark:border-green-800', iconClass: 'text-green-500' },
  error:   { icon: AlertCircle,    headerClass: 'bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-800',         iconClass: 'text-red-500' },
} as const;

export default function NotificationBanner({ companyId }: NotificationBannerProps) {
  const { data: notifications = [] } = useCompanyNotifications(companyId, 20);
  const markRead = useMarkNotificationsRead();
  const [index, setIndex] = useState(0);

  const unread = notifications.filter((n) => !n.is_read);
  if (unread.length === 0) return null;

  const current = unread[Math.min(index, unread.length - 1)];
  const total = unread.length;
  const typeKey = (current.type ?? 'info') as keyof typeof TYPE_CONFIG;
  const { icon: TypeIcon, headerClass, iconClass } = TYPE_CONFIG[typeKey] ?? TYPE_CONFIG.info;

  function handleRead(id: string) {
    markRead.mutate({ companyId, ids: [id] });
    setIndex((i) => Math.max(0, Math.min(i, total - 2)));
  }

  function handleReadAll() {
    markRead.mutate({ companyId, ids: unread.map((n) => n.id) });
    setIndex(0);
  }

  return (
    <>
      {/* Backdrop blur */}
      <div className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm" aria-hidden />

      {/* Card */}
      <div className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-lg -translate-y-1/2 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          {/* Header colorido pelo tipo */}
          <div className={`flex items-center gap-3 border-b px-4 py-3 ${headerClass}`}>
            <div className="flex min-w-0 items-center gap-2">
              <TypeIcon className={`h-4 w-4 shrink-0 ${iconClass}`} />
              <span className="truncate text-sm font-semibold text-foreground">{current.title}</span>
              {total > 1 && (
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  {index + 1}/{total}
                </span>
              )}
            </div>
          </div>

          {/* Imagem */}
          {current.image_url && (
            <img
              src={current.image_url}
              alt=""
              className="max-h-48 w-full object-cover"
            />
          )}

          {/* Conteúdo rich text */}
          <div
            className="prose prose-sm max-w-none px-4 py-4 text-foreground [&_a]:text-primary [&_a]:underline [&_img]:rounded-lg [&_img]:max-w-full"
            dangerouslySetInnerHTML={{ __html: current.message }}
          />

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <div className="flex items-center gap-1">
              {total > 1 && (
                <>
                  <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => setIndex((i) => i - 1)} className="h-8 px-2">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" disabled={index === total - 1} onClick={() => setIndex((i) => i + 1)} className="h-8 px-2">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {total > 1 && (
                <Button variant="outline" size="sm" onClick={handleReadAll} disabled={markRead.isPending} className="gap-1.5">
                  <CheckCheck className="h-4 w-4" />
                  Marcar todas
                </Button>
              )}
              <Button size="sm" onClick={() => handleRead(current.id)} disabled={markRead.isPending} className="gap-1.5">
                <CheckCheck className="h-4 w-4" />
                Marcar como lido
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
