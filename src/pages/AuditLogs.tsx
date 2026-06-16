import { useState } from 'react';
import { ScrollText, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuditLogs } from '@/hooks/useSettings';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const actionLabels: Record<string, string> = {
  create_company: 'Criou empresa',
  update_company: 'Atualizou empresa',
  delete_company: 'Removeu empresa',
  pause_company: 'Pausou empresa',
  activate_company: 'Ativou empresa',
  create_user: 'Criou usuário',
  update_user: 'Atualizou usuário',
  delete_user: 'Excluiu usuário',
  block_user: 'Bloqueou usuário',
  unblock_user: 'Desbloqueou usuário',
  set_user_password: 'Alterou senha de usuário',
  reset_password: 'Redefiniu senha',
  update_own_profile: 'Atualizou o proprio perfil',
  change_own_password: 'Alterou a propria senha',
  send_notification: 'Enviou notificação',
  delete_notification: 'Removeu notificação',
  update_settings: 'Atualizou configurações',
};

function formatLogSummary(details: Record<string, any> | null | undefined) {
  if (!details || Object.keys(details).length === 0) return 'Sem detalhes adicionais';

  const preferredKeys = [
    'target_name',
    'target_email',
    'name',
    'email',
    'title',
    'key',
    'company_id',
    'role',
    'status',
  ];

  const parts = preferredKeys
    .filter((key) => details[key] !== undefined && details[key] !== null && details[key] !== '')
    .slice(0, 3)
    .map((key) => `${key}: ${String(details[key])}`);

  return parts.length > 0 ? parts.join(' | ') : JSON.stringify(details);
}

export default function AuditLogs() {
  const { data: logs = [], isLoading } = useAuditLogs(100);
  const [selectedLog, setSelectedLog] = useState<(typeof logs)[number] | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Logs de Ações</h1>
        <p className="text-muted-foreground mt-1">Histórico de ações realizadas pelo superadmin</p>
      </div>

      {isLoading ? (
        <Card className="border-none shadow-sm"><CardContent className="p-6 space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</CardContent></Card>
      ) : logs.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <ScrollText className="h-12 w-12 mx-auto mb-3 opacity-30" />
            Nenhum log registrado ainda.
          </CardContent>
        </Card>
      ) : (
        <Card className="border-none shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Data/Hora</TableHead>
                <TableHead>Quem</TableHead>
                <TableHead>Ação</TableHead>
                <TableHead>Entidade</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Detalhes</TableHead>
                <TableHead className="text-right">Ver</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map(log => (
                <TableRow key={log.id}>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {format(new Date(log.created_at), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}
                  </TableCell>
                  <TableCell className="text-sm">
                    <div className="min-w-[180px]">
                      <p className="font-medium">{log.actor_name || 'Usuário sem perfil'}</p>
                      <p className="text-muted-foreground break-all">{log.actor_email || log.user_id}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {actionLabels[log.action] || log.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {log.entity_type || '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono">
                    {log.ip_address || '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[320px] whitespace-normal break-words">
                    {formatLogSummary(log.details)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setSelectedLog(log)}>
                      Ver tudo
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Detalhes do log</DialogTitle>
            <DialogDescription>
              Visualização completa da ação registrada, incluindo autor e payload bruto.
            </DialogDescription>
          </DialogHeader>

          {selectedLog && (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Data/Hora</p>
                  <p className="text-sm">{format(new Date(selectedLog.created_at), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Ação</p>
                  <p className="text-sm">{actionLabels[selectedLog.action] || selectedLog.action}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Quem realizou</p>
                  <p className="text-sm font-medium">{selectedLog.actor_name || 'Usuário sem perfil'}</p>
                  <p className="text-xs text-muted-foreground break-all">{selectedLog.actor_email || selectedLog.user_id}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">IP</p>
                  <p className="text-sm font-mono">{selectedLog.ip_address || '—'}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Entidade</p>
                  <p className="text-sm">{selectedLog.entity_type || '—'}</p>
                  <p className="text-xs text-muted-foreground break-all">{selectedLog.entity_id || 'Sem entity_id'}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Usuário autor</p>
                  <p className="text-sm break-all">{selectedLog.user_id}</p>
                </div>
              </div>

              <div className="rounded-lg border">
                <div className="border-b px-4 py-3">
                  <p className="text-sm font-medium">Payload completo</p>
                </div>
                <ScrollArea className="max-h-[420px]">
                  <pre className="whitespace-pre-wrap break-words p-4 text-xs leading-6">
                    {JSON.stringify(selectedLog.details ?? {}, null, 2)}
                  </pre>
                </ScrollArea>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
