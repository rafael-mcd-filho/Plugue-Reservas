import { useState } from 'react';
import { Webhook, Plus, Trash2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useWebhookConfigs, useCreateWebhook, useUpdateWebhook, useDeleteWebhook } from '@/hooks/useAutomations';

interface Props {
  companyId: string;
}

const EVENTS = [
  { key: 'reservation_created', label: 'Reserva criada' },
  { key: 'reservation_cancelled', label: 'Reserva cancelada' },
  { key: 'status_changed', label: 'Status alterado' },
];

export default function WebhooksTab({ companyId }: Props) {
  const { data: webhooks = [], isLoading } = useWebhookConfigs(companyId);
  const createWebhook = useCreateWebhook();
  const updateWebhook = useUpdateWebhook();
  const deleteWebhook = useDeleteWebhook();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ url: '', events: [] as string[], secret: '' });

  const toggleEvent = (key: string) => {
    setForm(prev => ({
      ...prev,
      events: prev.events.includes(key) ? prev.events.filter(e => e !== key) : [...prev.events, key],
    }));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.url || form.events.length === 0) return;
    await createWebhook.mutateAsync({
      company_id: companyId,
      url: form.url,
      events: form.events,
      secret: form.secret || undefined,
    });
    setForm({ url: '', events: [], secret: '' });
    setDialogOpen(false);
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-48 w-full" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Webhook className="h-5 w-5 text-primary" /> Webhooks
          </h3>
          <p className="text-sm text-muted-foreground">Receba notificações em tempo real sobre eventos de reserva</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> Novo Webhook</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Novo Webhook</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 mt-4">
              <div>
                <Label>URL do Webhook *</Label>
                <Input value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} placeholder="https://seu-servidor.com/webhook" />
              </div>
              <div>
                <Label>Eventos *</Label>
                <div className="space-y-2 mt-2">
                  {EVENTS.map(ev => (
                    <div key={ev.key} className="flex items-center gap-2">
                      <Checkbox
                        id={`ev-${ev.key}`}
                        checked={form.events.includes(ev.key)}
                        onCheckedChange={() => toggleEvent(ev.key)}
                      />
                      <label htmlFor={`ev-${ev.key}`} className="text-sm cursor-pointer">{ev.label}</label>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <Label>Secret (opcional)</Label>
                <Input value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} placeholder="Chave secreta para validação" />
                <p className="text-xs text-muted-foreground mt-1">Enviada no header X-Webhook-Secret para verificação</p>
              </div>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
                <Button type="submit" disabled={createWebhook.isPending || !form.url || form.events.length === 0}>Criar</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {webhooks.length === 0 ? (
        <Card className="border border-border shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Webhook className="h-12 w-12 mx-auto mb-3 opacity-30" />
            Nenhum webhook configurado.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {webhooks.map(wh => (
            <Card key={wh.id} className="border border-border shadow-sm">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2">
                      <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-mono truncate">{wh.url}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(wh.events as string[]).map(ev => {
                        const label = EVENTS.find(e => e.key === ev)?.label || ev;
                        return <Badge key={ev} variant="secondary" className="text-xs">{label}</Badge>;
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={wh.enabled}
                      onCheckedChange={(checked) =>
                        updateWebhook.mutate({ id: wh.id, company_id: companyId, enabled: checked })
                      }
                    />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remover webhook?</AlertDialogTitle>
                          <AlertDialogDescription>Esta ação não pode ser desfeita.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteWebhook.mutate({ id: wh.id, company_id: companyId })}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Remover
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
