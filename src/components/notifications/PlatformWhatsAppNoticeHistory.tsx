import { useState } from 'react';
import { format } from 'date-fns';
import { AlertCircle, Ban, CheckCircle2, Clock3, HelpCircle, Loader2, MessageCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePlatformWhatsAppNotices, useRetryPlatformWhatsAppNotice } from '@/hooks/usePlatformWhatsAppNotices';
import { noticeImageUrl, type PlatformWhatsAppNotice } from '@/lib/platform-whatsapp-notices';
import { formatPhone } from '@/lib/phone';

const PAGE_SIZE = 25;
const statusPresentation = {
  queued: { label: 'Na fila', icon: Clock3, tone: 'bg-info-soft text-info' },
  processing: { label: 'Enviando', icon: Loader2, tone: 'bg-info-soft text-info' },
  accepted: { label: 'Enviado', icon: CheckCircle2, tone: 'bg-success-soft text-success' },
  failed: { label: 'Falhou', icon: AlertCircle, tone: 'bg-destructive-soft text-destructive' },
  unknown: { label: 'Sem confirmação', icon: HelpCircle, tone: 'bg-amber-50 text-amber-900' },
  skipped: { label: 'Não enviado', icon: Ban, tone: 'bg-muted text-muted-foreground' },
};

export default function PlatformWhatsAppNoticeHistory() {
  const [offset, setOffset] = useState(0);
  const query = usePlatformWhatsAppNotices({ enabled: true, offset, limit: PAGE_SIZE });
  const retry = useRetryPlatformWhatsAppNotice();
  async function retryNotice(notice: PlatformWhatsAppNotice) {
    try {
      const result = await retry.mutateAsync({ notice_id: notice.id });
      const updated = result.rows.find(row => row.id === notice.id);
      if (!updated) { toast.error('Atualize o histórico para conferir a tentativa.'); return; }
      if (updated.status === 'queued' || updated.status === 'processing') toast.success('Nova tentativa adicionada à fila.');
      else if (updated.status === 'accepted') toast.success('Este aviso já foi enviado.');
      else if (updated.status === 'failed') toast.error(updated.error_message || 'Não foi possível enviar o aviso.');
      else toast.info(updated.error_message || 'O aviso não foi reenviado. Confira o histórico.');
    }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível tentar novamente.'); }
  }
  if (query.isPending) return <Card><CardContent role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin"/>Carregando envios…</CardContent></Card>;
  if (query.isError) return <Card><CardContent role="alert" className="space-y-3 p-5"><p className="text-sm">Não foi possível carregar os envios pelo WhatsApp.</p><Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Tentar novamente</Button></CardContent></Card>;
  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">RWSL · Telefone do responsável. O status Enviado indica aceite pela instância, sem confirmação de leitura.</p>
    <Card className="overflow-hidden border-none shadow-sm">
      {rows.length === 0 ? <CardContent className="py-12 text-center text-muted-foreground"><MessageCircle aria-hidden="true" className="mx-auto mb-3 h-10 w-10 opacity-40"/><p>Nenhum envio pelo WhatsApp neste recorte.</p></CardContent>
        : <Table><TableHeader><TableRow><TableHead>Aviso</TableHead><TableHead>Empresa e contato</TableHead><TableHead>Status</TableHead><TableHead>Data</TableHead><TableHead className="text-right">Ações</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map(notice => {
            const status = statusPresentation[notice.status];
            const Icon = status.icon;
            return <TableRow key={notice.id}>
              <TableCell><div className="flex min-w-[180px] items-start gap-2.5"><img src={noticeImageUrl(notice.image_path)} alt="Imagem do aviso" loading="lazy" className="h-12 w-14 shrink-0 rounded-md border bg-muted/30 object-cover"/><p className="max-w-xs whitespace-pre-wrap break-words text-xs leading-relaxed">{notice.caption}</p></div></TableCell>
              <TableCell><p className="text-sm font-medium">{notice.company_name}</p><p className="mt-1 text-xs text-muted-foreground">{notice.recipient_phone ? formatPhone(notice.recipient_phone) : 'Sem contato válido'}</p></TableCell>
              <TableCell><span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${status.tone}`}><Icon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${notice.status === 'processing' ? 'animate-spin motion-reduce:animate-none' : ''}`}/>{status.label}</span>
                {notice.error_message && <p className="mt-1 max-w-[230px] text-xs text-muted-foreground">{notice.error_message}</p>}
                {notice.status === 'unknown' && <p className="mt-1 max-w-[230px] text-xs text-muted-foreground">Confira o envio na RWSL antes de criar outro aviso para este contato.</p>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{format(new Date(notice.created_at), 'dd/MM/yyyy HH:mm')}</TableCell>
              <TableCell className="text-right">{(notice.status === 'failed' || notice.status === 'skipped') && <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={retry.isPending} onClick={() => void retryNotice(notice)} aria-label={`Tentar novamente para ${notice.company_name}`}><RefreshCw aria-hidden="true" className="h-3.5 w-3.5"/>Tentar novamente</Button>}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>}
    </Card>
    {total > PAGE_SIZE && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{Math.min(offset + 1, total)}–{Math.min(offset + rows.length, total)} de {total} envios</span><div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>Anterior</Button><Button type="button" variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total || query.isFetching} onClick={() => setOffset(value => value + PAGE_SIZE)}>Próxima</Button></div></div>}
    {offset > 0 && rows.length === 0 && <Button type="button" variant="outline" size="sm" onClick={() => setOffset(0)}>Voltar ao início</Button>}
  </div>;
}
