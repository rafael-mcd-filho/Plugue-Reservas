import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plug, Eye, EyeOff, Loader2, Save, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSystemSettings, useUpdateSetting } from '@/hooks/useSettings';

export default function AdminIntegrations() {
  const { data: settings = [], isLoading } = useSystemSettings();
  const updateSetting = useUpdateSetting();

  const getSetting = (key: string) => settings.find(s => s.key === key)?.value || '';

  const [evolutionUrl, setEvolutionUrl] = useState('');
  const [evolutionToken, setEvolutionToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [internalJobSecret, setInternalJobSecret] = useState('');
  const [showJobSecret, setShowJobSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (settings.length === 0) return;
    setEvolutionUrl(getSetting('evolution_api_url'));
    setEvolutionToken(getSetting('evolution_api_token'));
    setInternalJobSecret(getSetting('internal_job_secret'));
  }, [settings]);

  const handleSave = async () => {
    await updateSetting.mutateAsync({ key: 'evolution_api_url', value: evolutionUrl || null, silent: true });
    await updateSetting.mutateAsync({ key: 'evolution_api_token', value: evolutionToken || null, silent: true });
    await updateSetting.mutateAsync({ key: 'internal_job_secret', value: internalJobSecret || null, silent: true });
    toast.success('Integrações salvas!');
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
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Integrações</h1>
          <p className="text-muted-foreground mt-1">Conexões externas do sistema</p>
        </div>
        <Card className="border-none shadow-sm"><CardContent className="p-6 space-y-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Integrações</h1>
        <p className="text-muted-foreground mt-1">Conexões externas do sistema</p>
      </div>

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
          <div>
            <Label>Segredo dos Jobs Internos</Label>
            <div className="relative">
              <Input
                type={showJobSecret ? 'text' : 'password'}
                value={internalJobSecret}
                onChange={e => setInternalJobSecret(e.target.value)}
                placeholder="Segredo usado pelos jobs automáticos"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowJobSecret(!showJobSecret)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showJobSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Usado para autenticar os jobs automáticos de lembretes, fila, pós-visita, aniversário e monitoramento do WhatsApp.
            </p>
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
    </div>
  );
}
