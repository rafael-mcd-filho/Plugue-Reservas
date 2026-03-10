import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, Plus, Phone, Clock, UserCheck, UserX, Bell, Copy } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface WaitlistEntry {
  id: string;
  company_id: string;
  guest_name: string;
  guest_phone: string;
  party_size: number;
  tracking_code: string;
  status: string;
  position: number;
  notes: string | null;
  called_at: string | null;
  seated_at: string | null;
  expired_at: string | null;
  created_at: string;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  waiting: { label: 'Aguardando', className: 'bg-amber-100 text-amber-700 border-amber-200' },
  called: { label: 'Chamado', className: 'bg-blue-100 text-blue-700 border-blue-200' },
  seated: { label: 'Sentado', className: 'bg-primary/15 text-primary border-primary/30' },
  expired: { label: 'Expirado', className: 'bg-muted text-muted-foreground border-border' },
  removed: { label: 'Removido', className: 'bg-destructive/15 text-destructive border-destructive/30' },
};

export default function CompanyWaitlist() {
  const { companyId, companyName, slug } = useCompanySlug();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ guest_name: '', guest_phone: '', party_size: 2, notes: '' });
  const [removeEntry, setRemoveEntry] = useState<WaitlistEntry | null>(null);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['waitlist', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('waitlist' as any)
        .select('*')
        .eq('company_id', companyId)
        .in('status', ['waiting', 'called'])
        .order('position', { ascending: true });
      if (error) throw error;
      return data as unknown as WaitlistEntry[];
    },
    refetchInterval: 10000,
  });

  const { data: todayStats } = useQuery({
    queryKey: ['waitlist-stats', companyId],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const { data, error } = await supabase
        .from('waitlist' as any)
        .select('status, created_at, seated_at')
        .eq('company_id', companyId)
        .gte('created_at', today + 'T00:00:00');
      if (error) throw error;
      const all = data as any[];
      const seated = all.filter(e => e.status === 'seated');
      const removed = all.filter(e => e.status === 'removed' || e.status === 'expired');
      const avgWait = seated.length > 0
        ? seated.reduce((sum, e) => sum + (new Date(e.seated_at).getTime() - new Date(e.created_at).getTime()), 0) / seated.length / 60000
        : 0;
      return { total: all.length, seated: seated.length, removed: removed.length, avgWaitMin: Math.round(avgWait) };
    },
    refetchInterval: 30000,
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const nextPosition = entries.length > 0 ? Math.max(...entries.map(e => e.position)) + 1 : 1;
      const { data, error } = await supabase
        .from('waitlist' as any)
        .insert({
          company_id: companyId,
          guest_name: addForm.guest_name,
          guest_phone: addForm.guest_phone,
          party_size: addForm.party_size,
          notes: addForm.notes || null,
          position: nextPosition,
          status: 'waiting',
        } as any)
        .select('*')
        .single();
      if (error) throw error;
      return data as any;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['waitlist', companyId] });
      qc.invalidateQueries({ queryKey: ['waitlist-stats', companyId] });
      const trackingUrl = `${window.location.origin}/${slug}/fila/${data.tracking_code}`;
      toast.success(
        <div className="space-y-1">
          <p>Cliente adicionado à fila!</p>
          <p className="text-xs text-muted-foreground">Código: <strong>{data.tracking_code}</strong></p>
        </div>
      );

      // Send WhatsApp notification
      const position = entries.length + 1;
      supabase.functions.invoke('reservation-events', {
        body: {
          event: 'waitlist_added',
          waitlist: { ...data, position, tracking_url: trackingUrl },
        },
      }).catch(err => console.warn('Waitlist notification error:', err));

      setShowAdd(false);
      setAddForm({ guest_name: '', guest_phone: '', party_size: 2, notes: '' });
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const updates: any = { status, updated_at: new Date().toISOString() };
      if (status === 'called') updates.called_at = new Date().toISOString();
      if (status === 'seated') updates.seated_at = new Date().toISOString();
      if (status === 'expired') updates.expired_at = new Date().toISOString();
      const { error } = await supabase.from('waitlist' as any).update(updates).eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['waitlist', companyId] });
      qc.invalidateQueries({ queryKey: ['waitlist-stats', companyId] });
      const labels: Record<string, string> = { called: 'Cliente chamado!', seated: 'Cliente sentado!', removed: 'Cliente removido.', expired: 'Entrada expirada.' };
      toast.success(labels[vars.status] || 'Atualizado!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const callNext = () => {
    const next = entries.find(e => e.status === 'waiting');
    if (!next) { toast.info('Fila vazia!'); return; }
    updateStatus.mutate({ id: next.id, status: 'called' });

    // Notify via WhatsApp
    supabase.functions.invoke('reservation-events', {
      body: { event: 'waitlist_called', waitlist: next },
    }).catch(err => console.warn('Waitlist call notification error:', err));
  };

  const copyTrackingLink = (code: string) => {
    const url = `${window.location.origin}/${slug}/fila/${code}`;
    navigator.clipboard.writeText(url);
    toast.success('Link copiado!');
  };

  const waitingCount = entries.filter(e => e.status === 'waiting').length;
  const calledCount = entries.filter(e => e.status === 'called').length;

  return (
    <TooltipProvider>
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Lista de Espera</h1>
          <p className="text-muted-foreground mt-1">Gerencie a fila de {companyName}</p>
        </div>
        <div className="flex gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" className="gap-2" onClick={callNext} disabled={waitingCount === 0}>
                <Bell className="h-4 w-4" /> Chamar Próximo
              </Button>
            </TooltipTrigger>
            <TooltipContent>Chama o próximo cliente da fila e envia notificação WhatsApp</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button className="gap-2" onClick={() => setShowAdd(true)}>
                <Plus className="h-4 w-4" /> Adicionar
              </Button>
            </TooltipTrigger>
            <TooltipContent>Adicionar novo cliente à fila de espera</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-amber-100"><Users className="h-4 w-4 text-amber-700" /></div>
              <div><p className="text-xl font-bold">{waitingCount}</p><p className="text-xs text-muted-foreground">Aguardando</p></div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-blue-100"><Bell className="h-4 w-4 text-blue-700" /></div>
              <div><p className="text-xl font-bold">{calledCount}</p><p className="text-xs text-muted-foreground">Chamados</p></div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10"><UserCheck className="h-4 w-4 text-primary" /></div>
              <div><p className="text-xl font-bold">{todayStats?.seated || 0}</p><p className="text-xs text-muted-foreground">Sentados hoje</p></div>
            </div>
          </CardContent>
        </Card>
        <Tooltip>
          <TooltipTrigger asChild>
            <Card className="border-none shadow-sm cursor-help">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-muted"><Clock className="h-4 w-4 text-muted-foreground" /></div>
                  <div><p className="text-xl font-bold">{todayStats?.avgWaitMin || 0}min</p><p className="text-xs text-muted-foreground">Espera média</p></div>
                </div>
              </CardContent>
            </Card>
          </TooltipTrigger>
          <TooltipContent>Média do tempo entre entrada na fila e ser sentado (apenas clientes sentados hoje)</TooltipContent>
        </Tooltip>
      </div>

      {/* Queue */}
      {isLoading ? (
        <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : entries.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
            Nenhum cliente na fila.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {entries.map((entry, idx) => {
            const sc = statusConfig[entry.status] || statusConfig.waiting;
            return (
              <Card key={entry.id} className="border-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted font-bold text-lg">
                      {entry.status === 'waiting' ? idx + 1 : '—'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold truncate">{entry.guest_name}</span>
                        <Badge className={`text-xs ${sc.className}`}>{sc.label}</Badge>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                        <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {entry.guest_phone}</span>
                        <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {entry.party_size}p</span>
                        <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true, locale: ptBR })}</span>
                      </div>
                      {entry.notes && <p className="text-xs text-muted-foreground mt-1">{entry.notes}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => copyTrackingLink(entry.tracking_code)}>
                            <Copy className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Copiar link de acompanhamento</TooltipContent>
                      </Tooltip>
                      {entry.status === 'waiting' && (
                        <>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="sm" variant="outline" className="gap-1" onClick={() => updateStatus.mutate({ id: entry.id, status: 'called' })}>
                                <Bell className="h-3.5 w-3.5" /> Chamar
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Chamar cliente e notificar via WhatsApp</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setRemoveEntry(entry)}>
                                <UserX className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Remover da fila</TooltipContent>
                          </Tooltip>
                        </>
                      )}
                      {entry.status === 'called' && (
                        <>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="sm" className="gap-1" onClick={() => updateStatus.mutate({ id: entry.id, status: 'seated' })}>
                                <UserCheck className="h-3.5 w-3.5" /> Sentou
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Marcar que o cliente sentou na mesa</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="sm" variant="outline" onClick={() => updateStatus.mutate({ id: entry.id, status: 'expired' })}>
                                <Clock className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Marcar como expirado (não compareceu)</TooltipContent>
                          </Tooltip>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Adicionar à Fila</DialogTitle></DialogHeader>
          <form onSubmit={e => { e.preventDefault(); addMutation.mutate(); }} className="space-y-4 mt-4">
            <div><Label>Nome *</Label><Input value={addForm.guest_name} onChange={e => setAddForm({ ...addForm, guest_name: e.target.value })} placeholder="Nome do cliente" required /></div>
            <div><Label>WhatsApp *</Label><Input value={addForm.guest_phone} onChange={e => setAddForm({ ...addForm, guest_phone: e.target.value })} placeholder="(84) 99999-9999" required /></div>
            <div>
              <Label>Pessoas</Label>
              <div className="flex items-center gap-2 mt-1">
                <Button variant="outline" size="icon" className="h-8 w-8" type="button" onClick={() => setAddForm(f => ({ ...f, party_size: Math.max(1, f.party_size - 1) }))}>-</Button>
                <span className="w-8 text-center font-semibold">{addForm.party_size}</span>
                <Button variant="outline" size="icon" className="h-8 w-8" type="button" onClick={() => setAddForm(f => ({ ...f, party_size: Math.min(20, f.party_size + 1) }))}>+</Button>
              </div>
            </div>
            <div><Label>Observações</Label><Textarea value={addForm.notes} onChange={e => setAddForm({ ...addForm, notes: e.target.value })} placeholder="Ex: cadeirante, aniversário..." rows={2} /></div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancelar</Button>
              <Button type="submit" disabled={addMutation.isPending}>{addMutation.isPending ? 'Adicionando...' : 'Adicionar'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <AlertDialog open={!!removeEntry} onOpenChange={open => !open && setRemoveEntry(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover da fila?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeEntry?.guest_name} será removido(a) da lista de espera.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => {
              if (removeEntry) updateStatus.mutate({ id: removeEntry.id, status: 'removed' });
              setRemoveEntry(null);
            }}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </TooltipProvider>
  );
}
