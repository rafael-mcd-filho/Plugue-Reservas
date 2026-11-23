import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Eye, EyeOff, Loader2, Wifi } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSaveSettings, type SystemSetting } from '@/hooks/useSettings';
import SettingsSectionCard from './SettingsSectionCard';
import { useSettingsDraft } from './useSettingsDraft';

const KEYS = ['evolution_api_url', 'evolution_api_token'] as const;

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function EvolutionApiCard({ settings }: { settings: SystemSetting[] }) {
  const saveSettings = useSaveSettings();
  const { saved, draft, dirty, setField, discard } = useSettingsDraft(settings, KEYS);
  const configured = !!saved.evolution_api_url && !!saved.evolution_api_token;
  const [editing, setEditing] = useState(!configured);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; at: Date } | null>(null);
  const showForm = editing || !configured;

  const handleSave = async () => {
    try {
      await saveSettings.mutateAsync({
        evolution_api_url: draft.evolution_api_url.trim() || null,
        evolution_api_token: draft.evolution_api_token.trim() || null,
      });
      toast.success('Conexão da Evolution API salva.');
      setEditing(false);
      setShowToken(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar. Nada foi alterado.');
    }
  };

  const handleTest = async () => {
    const url = (showForm ? draft.evolution_api_url : saved.evolution_api_url).trim();
    const token = (showForm ? draft.evolution_api_token : saved.evolution_api_token).trim();
    if (!url || !token) {
      setTestResult({ ok: false, message: 'Preencha o endereço e o token antes de testar.', at: new Date() });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/instance/fetchInstances`, { headers: { apikey: token } });
      setTestResult(response.ok
        ? { ok: true, message: 'Servidor acessível e token aceito.', at: new Date() }
        : { ok: false, message: `O servidor respondeu com erro ${response.status}.`, at: new Date() });
    } catch (error) {
      setTestResult({
        ok: false,
        message: `Falha na conexão: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
        at: new Date(),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsSectionCard
      title="Evolution API"
      description="Servidor de WhatsApp usado pelas empresas: lembretes, fila de espera e pós-visita."
      status={configured
        ? <Badge variant="outline" className="border-success/25 bg-success-soft text-success">Configurada</Badge>
        : <Badge variant="outline" className="border-warning/30 bg-warning-soft text-amber-900">Não configurada</Badge>}
      dirty={dirty}
      saving={saveSettings.isPending}
      onSave={showForm ? handleSave : undefined}
      onDiscard={() => {
        discard();
        if (configured) setEditing(false);
      }}
      extraActions={(
        <>
          {!showForm && (
            <Button type="button" variant="outline" onClick={() => setEditing(true)}>
              Alterar conexão
            </Button>
          )}
          {showForm && configured && !dirty && (
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={handleTest} disabled={testing} className="gap-2">
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
            Testar conexão
          </Button>
        </>
      )}
    >
      {showForm ? (
        <div className="grid max-w-lg gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="evolution-url">Endereço da Evolution API</Label>
            <Input
              id="evolution-url"
              value={draft.evolution_api_url}
              onChange={(event) => setField('evolution_api_url', event.target.value)}
              placeholder="https://evolution.seudominio.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="evolution-token">Token global (API Key)</Label>
            <div className="relative">
              <Input
                id="evolution-token"
                type={showToken ? 'text' : 'password'}
                value={draft.evolution_api_token}
                onChange={(event) => setField('evolution_api_token', event.target.value)}
                placeholder="Token global da Evolution API"
                autoComplete="new-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken((current) => !current)}
                aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <dl className="grid max-w-lg grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Servidor</dt>
          <dd className="break-all">{hostOf(saved.evolution_api_url)}</dd>
          <dt className="text-muted-foreground">Token</dt>
          <dd>Salvo</dd>
        </dl>
      )}
      {testResult && (
        <div
          role={testResult.ok ? 'status' : 'alert'}
          className={`flex max-w-lg items-start gap-2 rounded-lg border p-3 text-sm ${testResult.ok ? 'border-success/30 bg-success-soft text-success' : 'border-destructive/30 bg-destructive-soft text-destructive'}`}
        >
          {testResult.ok && <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>
            {testResult.message}
            <span className="block text-xs opacity-80">Testado às {testResult.at.toLocaleTimeString('pt-BR')}. O teste confirma o servidor, não cada instância.</span>
          </span>
        </div>
      )}
    </SettingsSectionCard>
  );
}
