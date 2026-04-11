import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCompanyNotifications, useMarkNotificationsRead } from '@/hooks/useSettings';
import { useCompanySlug } from '@/contexts/CompanySlugContext';

export default function CompanyNotificationsPopover() {
  const { companyId } = useCompanySlug();
  const { data: notifications = [], isLoading } = useCompanyNotifications(companyId, 12);
  const markRead = useMarkNotificationsRead();

  const unreadIds = notifications.filter((notification) => !notification.is_read).map((notification) => notification.id);
  const unreadCount = unreadIds.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className="relative" aria-label="Notificações da empresa">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[calc(100vw-2rem)] max-w-[360px] p-0">
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Notificações</p>
              <p className="text-xs text-muted-foreground">Comunicados do superadmin para esta empresa</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={unreadCount === 0 || markRead.isPending}
              onClick={() => markRead.mutate({ companyId, ids: unreadIds })}
            >
              {markRead.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
              )}
              Marcar lidas
            </Button>
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Carregando notificações...
            </div>
          ) : notifications.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              Nenhuma notificação para esta empresa.
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => (
                <div key={notification.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{notification.title}</p>
                        {!notification.is_read && (
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            Nova
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                        {notification.message}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true, locale: ptBR })}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
