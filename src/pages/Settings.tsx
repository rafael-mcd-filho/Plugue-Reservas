import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Settings as SettingsIcon, Bell, ScrollText, Save, Send, Trash2, Building2, CheckCircle2, Clock, Plug, Eye, EyeOff, Loader2, Wifi, Upload, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  useSystemSettings, useUpdateSetting,
  useAuditLogs,
  useNotifications, useCreateNotification, useDeleteNotification,
} from '@/hooks/useSettings';
import { useCompanies } from '@/hooks/useCompanies';
import { DEFAULT_SYSTEM_NAME } from '@/lib/branding';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const notifTypeConfig: Record<string, { label: string; className: string }> = {
  info: { label: 'Informação', className: 'bg-info-soft text-info border-info/30' },
  warning: { label: 'Aviso', className: 'bg-warning-soft text-warning border-warning/30' },
  success: { label: 'Sucesso', className: 'bg-primary/15 text-primary border-primary/30' },
  error: { label: 'Erro', className: 'bg-destructive-soft text-destructive border-destructive/30' },
};

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

export default function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Configurações</h1>
        <p className="text-muted-foreground mt-1">Configurações gerais do sistema</p>
      </div>

      <Tabs defaultValue="general" className="space-y-6">
        <TabsList>
          <TabsTrigger value="general" className="gap-2">
            <SettingsIcon className="h-4 w-4" /> Geral
          </TabsTrigger>
          <TabsTrigger value="notifications" className="gap-2">
            <Bell className="h-4 w-4" /> Notificações
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <ScrollText className="h-4 w-4" /> Logs de Ações
          </TabsTrigger>
          <TabsTrigger value="integrations" className="gap-2">
            <Plug className="h-4 w-4" /> Integrações
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general"><GeneralTab /></TabsContent>
        <TabsContent value="notifications"><NotificationsTab /></TabsContent>
        <TabsContent value="logs"><LogsTab /></TabsContent>
        <TabsContent value="integrations"><IntegrationsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function GeneralTab() {
  const { data: settings = [], isLoading } = useSystemSettings();
  const updateSetting = useUpdateSetting();

  const getSetting = (key: string) => settings.find(s => s.key === key)?.value || '';

  const [systemName, setSystemName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (settings.length === 0) return;
    setSystemName(getSetting('system_name'));
    setLogoUrl(getSetting('system_logo_url'));
  }, [settings]);

  const handleSave = async () => {
    await updateSetting.mutateAsync({ key: 'system_name', value: systemName });
    await updateSetting.mutateAsync({ key: 'system_logo_url', value: logoUrl || null });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Selecione um arquivo de imagem (PNG, JPG, SVG, etc.)');
      return;
    }

    // Max 2MB
    if (file.size > 2 * 1024 * 1024) {
      toast.error('O arquivo deve ter no máximo 2MB');
      return;
    }

    setUploading(true);
    try {
      const ext = file.name.split('.').pop() || 'png';
      const fileName = `logo-${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('system-assets')
        .upload(fileName, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from('system-assets')
        .getPublicUrl(fileName);

      setLogoUrl(publicUrlData.publicUrl);
      toast.success('Logo enviado com sucesso!');
    } catch (err: any) {
      toast.error(`Erro ao enviar: ${err.message}`);
    } finally {
      setUploading(false);
      // Reset input
      e.target.value = '';
    }
  };

  if (isLoading) {
    return <Card className="border-none shadow-sm"><CardContent className="p-6 space-y-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></CardContent></Card>;
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <CardTitle className="text-base">Configurações Gerais</CardTitle>
        <CardDescription>Nome e logo exibidos no sistema</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 max-w-md">
          <div>
            <Label>Nome do Sistema</Label>
            <Input value={systemName} onChange={e => setSystemName(e.target.value)} placeholder={DEFAULT_SYSTEM_NAME} />
          </div>
          <div>
            <Label>Logo do Sistema</Label>
            <div className="flex gap-2 mt-1">
              <Input value={logoUrl} onChange={e => setLogoUrl(e.target.value)} placeholder="https://exemplo.com/logo.png" className="flex-1" />
              <div className="relative">
                <input type="file" accept="image/*" onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                <Button variant="outline" size="icon" type="button" disabled={uploading} className="pointer-events-none">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Cole uma URL ou envie um arquivo (máx. 2MB)</p>
            <div className="mt-2 p-4 bg-muted rounded-lg min-h-[64px] flex items-center justify-center">
              {logoUrl ? (
                <img src={logoUrl} alt="Logo preview" className="max-h-16 object-contain" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              ) : (
                <p className="text-xs text-muted-foreground">Preview do logo aparecerá aqui</p>
              )}
            </div>
          </div>
          <Button onClick={handleSave} disabled={updateSetting.isPending} className="gap-2 w-fit">
            <Save className="h-4 w-4" /> Salvar Configurações
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NotificationsTab() {
  const { data: notifications = [], isLoading } = useNotifications();
  const { data: companies = [] } = useCompanies();
  const createNotification = useCreateNotification();
  const deleteNotification = useDeleteNotification();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ company_ids: [] as string[], title: '', message: '', type: 'info' });
  const [sendToAll, setSendToAll] = useState(true);

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
      type: form.type,
    });
    setForm({ company_ids: [], title: '', message: '', type: 'info' });
    setSendToAll(true);
    setDialogOpen(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Notificações</h2>
          <p className="text-sm text-muted-foreground">Envie avisos para empresas específicas ou para todas</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Send className="h-4 w-4" /> Nova Notificação</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Enviar Notificação</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSend} className="space-y-4 mt-4">
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
                <Textarea value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} placeholder="Mensagem..." rows={3} />
              </div>
              <div className="flex justify-end gap-3">
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
                      {n.is_read ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Lida
                          {n.read_at && (
                            <span className="text-muted-foreground ml-1">
                              {format(new Date(n.read_at), "dd/MM HH:mm", { locale: ptBR })}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
                          <Clock className="h-3.5 w-3.5" /> Não lida
                        </span>
                      )}
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
    </div>
  );
}

function LogsTab() {
  const { data: logs = [], isLoading } = useAuditLogs(100);
  const [selectedLog, setSelectedLog] = useState<(typeof logs)[number] | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Logs de Ações</h2>
        <p className="text-sm text-muted-foreground">Histórico de ações realizadas pelo superadmin</p>
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

function IntegrationsTab() {
  const { data: settings = [], isLoading } = useSystemSettings();
  const updateSetting = useUpdateSetting();

  const getSetting = (key: string) => settings.find(s => s.key === key)?.value || '';

  const [evolutionUrl, setEvolutionUrl] = useState('');
  const [evolutionToken, setEvolutionToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (settings.length === 0) return;
    setEvolutionUrl(getSetting('evolution_api_url'));
    setEvolutionToken(getSetting('evolution_api_token'));
  }, [settings]);

  const handleSave = async () => {
    await updateSetting.mutateAsync({ key: 'evolution_api_url', value: evolutionUrl || null });
    await updateSetting.mutateAsync({ key: 'evolution_api_token', value: evolutionToken || null });
  };

  const handleTestConnection = async () => {
    if (!evolutionUrl || !evolutionToken) {
      setTestResult({ ok: false, message: 'Preencha URL e Token antes de testar.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const url = evolutionUrl.replace(/\/$/, '');
      const res = await fetch(`${url}/instance/fetchInstances`, {
        headers: { apikey: evolutionToken },
      });
      if (res.ok) {
        setTestResult({ ok: true, message: 'Conexão estabelecida com sucesso!' });
      } else {
        setTestResult({ ok: false, message: `Erro ${res.status}: ${res.statusText}` });
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: `Falha na conexão: ${err.message}` });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return <Card className="border-none shadow-sm"><CardContent className="p-6 space-y-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></CardContent></Card>;
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Plug className="h-5 w-5 text-primary" /> Evolution API</CardTitle>
        <CardDescription>Configure a conexão com a Evolution API para integração WhatsApp</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-lg">
        <div>
          <Label>URL da Evolution API</Label>
          <Input value={evolutionUrl} onChange={e => setEvolutionUrl(e.target.value)} placeholder="https://evolution.seudominio.com" />
          <p className="text-xs text-muted-foreground mt-1">Endereço base da sua instância Evolution API</p>
        </div>
        <div>
          <Label>Token Global (API Key)</Label>
          <div className="relative">
            <Input
              type={showToken ? 'text' : 'password'}
              value={evolutionToken}
              onChange={e => setEvolutionToken(e.target.value)}
              placeholder="Seu token global da Evolution API"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Encontrado nas configurações da sua Evolution API</p>
        </div>
        <div className="flex gap-3">
          <Button onClick={handleSave} disabled={updateSetting.isPending} className="gap-2">
            <Save className="h-4 w-4" /> Salvar Integrações
          </Button>
          <Button variant="outline" onClick={handleTestConnection} disabled={testing} className="gap-2">
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
            Testar Conexão
          </Button>
        </div>
        {testResult && (
          <div className={`rounded-lg border p-3 text-sm ${testResult.ok ? 'border-success/30 bg-success-soft text-success' : 'border-destructive/30 bg-destructive-soft text-destructive'}`}>
            {testResult.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
