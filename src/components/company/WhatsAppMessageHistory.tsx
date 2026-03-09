import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { MessageCircle, CheckCircle2, XCircle, Clock, History } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Props {
  companyId: string;
}

const typeLabels: Record<string, string> = {
  confirmation: 'Confirmação',
  reminder_1h: 'Lembrete 1h',
};

const statusConfig: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  sent: { label: 'Enviado', icon: CheckCircle2, className: 'text-primary' },
  error: { label: 'Erro', icon: XCircle, className: 'text-destructive' },
  pending: { label: 'Pendente', icon: Clock, className: 'text-muted-foreground' },
};

export default function WhatsAppMessageHistory({ companyId }: Props) {
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['whatsapp-message-logs', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('whatsapp_message_logs' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as any[];
    },
    enabled: !!companyId,
    refetchInterval: 30000,
  });

  if (isLoading) {
    return <Card className="border border-border shadow-sm"><CardContent className="p-6 space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</CardContent></Card>;
  }

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-5 w-5 text-primary" /> Histórico de Mensagens
        </CardTitle>
        <CardDescription>Últimas 100 mensagens WhatsApp enviadas</CardDescription>
      </CardHeader>
      <CardContent>
        {logs.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <MessageCircle className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">Nenhuma mensagem enviada ainda</p>
          </div>
        ) : (
          <div className="overflow-auto max-h-[500px]">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Data/Hora</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Mensagem</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log: any) => {
                  const sc = statusConfig[log.status] || statusConfig.pending;
                  const StatusIcon = sc.icon;
                  return (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {format(new Date(log.created_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-xs">
                          {typeLabels[log.type] || log.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm font-mono">{log.phone}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[250px] truncate" title={log.message}>
                        {log.message}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${sc.className}`}>
                          <StatusIcon className="h-3.5 w-3.5" /> {sc.label}
                        </span>
                        {log.error_details && (
                          <p className="text-xs text-destructive mt-1 max-w-[200px] truncate" title={log.error_details}>
                            {log.error_details}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
