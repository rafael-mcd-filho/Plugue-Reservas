import { useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Bell, Send, Trash2, Building2, CheckCircle2, Clock, Loader2, ChevronRight, Upload, X, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import {
  useNotifications, useCreateNotification, useDeleteNotification,
  useNotificationRecipientStatuses,
  type Notification,
} from '@/hooks/useSettings';
import { useCompanies } from '@/hooks/useCompanies';
import RichTextEditor from '@/components/RichTextEditor';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const notifTypeConfig: Record<string, { label: string; className: string }> = {
  info: { label: 'Informação', className: 'bg-info-soft text-info border-info/30' },
  warning: { label: 'Aviso', className: 'bg-warning-soft text-warning border-warning/30' },
  success: { label: 'Sucesso', className: 'bg-primary/15 text-primary border-primary/30' },
  error: { label: 'Erro', className: 'bg-destructive-soft text-destructive border-destructive/30' },
};

function getNotificationDeliveryLabel(notification: Notification) {
  const total = notification.recipient_count ?? 0;
  const read = notification.read_count ?? 0;

  if (total === 0) return 'Sem destinatários';
  if (read === 0) return 'Não lida';
  if (read === total) return 'Lida por todos';
  return `${read} de ${total} leram`;
}

function NotificationDeliveryDialog({
  notification,
  companyName,
  onOpenChange,
}: {
  notification: Notification | null;
  companyName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: recipients = [], isLoading } = useNotificationRecipientStatuses(notification?.id ?? null);
  const total = notification?.recipient_count ?? 0;
  const read = notification?.read_count ?? 0;
  const progress = total > 0 ? Math.round((read / total) * 100) : 0;

  return (
    <Dialog open={!!notification} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-14">
          <DialogTitle>Leituras da notificação</DialogTitle>
          <DialogDescription>{companyName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 border-b border-border bg-muted/30 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-sm font-medium">{notification?.title}</p>
            <span className="shrink-0 text-xs font-semibold text-muted-foreground">
              {read}/{total}
            </span>
          </div>
          <Progress value={progress} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {total === 0
              ? 'Nenhum usuário ativo recebeu este aviso.'
              : `${read} de ${total} usuários confirmaram a leitura.`}
          </p>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center px-5 py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Carregando destinatários...
            </div>
          ) : recipients.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              Nenhum destinatário registrado.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {recipients.map((recipient, index) => (
                <div key={`${recipient.user_id ?? 'removed'}-${index}`} className="flex items-center gap-3 px-5 py-3">
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                    recipient.read_at ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}>
                    {recipient.read_at ? <CheckCircle2 className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{recipient.full_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {recipient.email || recipient.roles.join(' / ')}
                    </p>
                  </div>
                  <p className={`shrink-0 text-xs ${recipient.read_at ? 'text-primary' : 'text-muted-foreground'}`}>
                    {recipient.read_at
                      ? format(new Date(recipient.read_at), "dd/MM HH:mm", { locale: ptBR })
                      : 'Pendente'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminNotifications() {
  const { data: notifications = [], isLoading } = useNotifications();
  const { data: companies = [] } = useCompanies();
  const createNotification = useCreateNotification();
  const deleteNotification = useDeleteNotification();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ company_ids: [] as string[], title: '', message: '', image_url: '', type: 'info' });
  const [sendToAll, setSendToAll] = useState(true);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [selectedNotification, setSelectedNotification] = useState<Notification | null>(null);
  const selectedNotificationCompany = companies.find((company) => company.id === selectedNotification?.company_id);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error('Imagem deve ter no máximo 10MB'); return; }
    setUploadingImage(true);
    try {
      const ext = file.name.split('.').pop();
      const path = `notification-images/${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('system-assets').upload(path, file, { upsert: false });
      if (error) throw error;
      const { data } = supabase.storage.from('system-assets').getPublicUrl(path);
      setForm((f) => ({ ...f, image_url: data.publicUrl }));
      toast.success('Imagem enviada!');
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setUploadingImage(false);
      e.target.value = '';
    }
  };

  const toggleCompany = (id: string) => {
    setForm(prev => ({
      ...prev,
      company_ids: prev.company_ids.includes(id)
        ? prev.company_ids.filter(c => c !== id)
        : [...prev.company_ids, id],
    }));
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title || !form.message) return;
    const targetCompanyIds = sendToAll ? companies.map(c => c.id) : form.company_ids;
    await createNotification.mutateAsync({
      company_ids: targetCompanyIds,
      title: form.title,
      message: form.message,
      image_url: form.image_url.trim() || null,
      type: form.type,
    });
    setForm({ company_ids: [], title: '', message: '', image_url: '', type: 'info' });
    setSendToAll(true);
    setDialogOpen(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Notificações</h1>
          <p className="text-muted-foreground mt-1">Envie avisos para empresas específicas ou para todas</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Send className="h-4 w-4" /> Nova Notificação</Button>
          </DialogTrigger>
          <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 max-w-2xl">
            <DialogHeader className="border-b border-border px-6 py-4">
              <DialogTitle>Enviar Notificação</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSend} className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
                <div className="space-y-3">
                  <Label>Destinatários</Label>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="send-all"
                      checked={sendToAll}
                      onCheckedChange={(checked) => {
                        setSendToAll(!!checked);
                        if (checked) setForm(prev => ({ ...prev, company_ids: [] }));
                      }}
                    />
                    <label htmlFor="send-all" className="text-sm font-medium cursor-pointer">Todas as empresas</label>
                  </div>
                  {!sendToAll && (
                    <div className="border rounded-lg p-3 max-h-40 overflow-y-auto space-y-2">
                      {companies.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nenhuma empresa cadastrada</p>
                      ) : companies.map(c => (
                        <div key={c.id} className="flex items-center gap-2">
                          <Checkbox
                            id={`company-${c.id}`}
                            checked={form.company_ids.includes(c.id)}
                            onCheckedChange={() => toggleCompany(c.id)}
                          />
                          <label htmlFor={`company-${c.id}`} className="text-sm cursor-pointer">{c.name}</label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <Label>Tipo</Label>
                  <Select value={form.type} onValueChange={v => setForm({ ...form, type: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="info">Informação</SelectItem>
                      <SelectItem value="warning">Aviso</SelectItem>
                      <SelectItem value="success">Sucesso</SelectItem>
                      <SelectItem value="error">Erro</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Título *</Label>
                  <Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Título da notificação" />
                </div>
                <div>
                  <Label>Mensagem *</Label>
                  <RichTextEditor
                    content={form.message}
                    onChange={(html) => setForm((f) => ({ ...f, message: html }))}
                    placeholder="Escreva a mensagem da notificação..."
                  />
                </div>
                <div>
                  <Label>Imagem <span className="text-muted-foreground text-xs">(opcional)</span></Label>
                  <div className="mt-1.5 flex gap-2">
                    <Input
                      value={form.image_url}
                      onChange={(e) => setForm((f) => ({ ...f, image_url: e.target.value }))}
                      placeholder="Cole uma URL ou faça upload..."
                      className="min-w-0 flex-1"
                    />
                    <label className="relative cursor-pointer">
                      <Button type="button" variant="outline" size="sm" className="gap-1.5 pointer-events-none h-10 px-3" disabled={uploadingImage}>
                        {uploadingImage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {uploadingImage ? 'Enviando...' : 'Upload'}
                      </Button>
                      <input
                        type="file"
                        accept="image/*"
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        onChange={handleImageUpload}
                        disabled={uploadingImage}
                      />
                    </label>
                    {form.image_url.trim() && (
                      <Button type="button" variant="ghost" size="sm" className="h-10 px-2 text-muted-foreground" onClick={() => setForm((f) => ({ ...f, image_url: '' }))}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  {form.image_url.trim() && (
                    <img
                      src={form.image_url}
                      alt="Preview"
                      className="mt-2 max-h-40 w-full rounded-lg border border-border object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
                <Button
                  type="submit"
                  disabled={
                    createNotification.isPending
                    || (sendToAll ? companies.length === 0 : form.company_ids.length === 0)
                  }
                  className="gap-2"
                >
                  <Send className="h-4 w-4" /> Enviar
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <Card className="border-none shadow-sm"><CardContent className="p-6 space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</CardContent></Card>
      ) : notifications.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Bell className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="mb-4">Nenhuma notificação enviada ainda.</p>
            <Button onClick={() => setDialogOpen(true)} className="gap-2">
              <Send className="h-4 w-4" /> Enviar primeira notificação
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-none shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Tipo</TableHead>
                <TableHead>Título</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notifications.map(n => {
                const tc = notifTypeConfig[n.type] || notifTypeConfig.info;
                const company = companies.find(c => c.id === n.company_id);
                return (
                  <TableRow key={n.id}>
                    <TableCell>
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${tc.className}`}>
                        {tc.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{n.title}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-[300px]">{n.message}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {company ? (
                        <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" /> {company.name}</span>
                      ) : 'Todas'}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto gap-1.5 px-1 py-1 text-xs"
                        onClick={() => setSelectedNotification(n)}
                      >
                        {(n.read_count ?? 0) === (n.recipient_count ?? 0) && (n.recipient_count ?? 0) > 0 ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                        ) : (n.read_count ?? 0) > 0 ? (
                          <Users className="h-3.5 w-3.5 text-warning" />
                        ) : (
                          <Clock className="h-3.5 w-3.5 text-warning" />
                        )}
                        <span>{getNotificationDeliveryLabel(n)}</span>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(n.created_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                    </TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remover notificação?</AlertDialogTitle>
                            <AlertDialogDescription>Esta ação não pode ser desfeita.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteNotification.mutate(n.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                              Remover
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <NotificationDeliveryDialog
        notification={selectedNotification}
        companyName={selectedNotificationCompany?.name ?? 'Empresa não encontrada'}
        onOpenChange={(open) => {
          if (!open) setSelectedNotification(null);
        }}
      />
    </div>
  );
}
