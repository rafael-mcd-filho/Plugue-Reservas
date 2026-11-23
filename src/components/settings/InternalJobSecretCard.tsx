import { useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSaveSettings, type SystemSetting } from '@/hooks/useSettings';
import SettingsSectionCard from './SettingsSectionCard';
import { useSettingsDraft } from './useSettingsDraft';

const KEYS = ['internal_job_secret'] as const;
const JOBS = ['Lembretes', 'Fila de espera', 'Pós-visita', 'Aniversário', 'Monitoramento do WhatsApp'];

export default function InternalJobSecretCard({ settings }: { settings: SystemSetting[] }) {
  const saveSettings = useSaveSettings();
  const { saved, draft, dirty, setField, discard } = useSettingsDraft(settings, KEYS);
  const configured = !!saved.internal_job_secret;
  const [editing, setEditing] = useState(!configured);
  const [showSecret, setShowSecret] = useState(false);
  const showForm = editing || !configured;

  const handleSave = async () => {
    try {
      await saveSettings.mutateAsync({ internal_job_secret: draft.internal_job_secret.trim() || null });
      toast.success('Segredo das rotinas salvo.');
      setEditing(false);
      setShowSecret(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar. Nada foi alterado.');
    }
  };

  return (
    <SettingsSectionCard
      title="Rotinas automáticas"
      description="Este segredo autentica todas as rotinas abaixo. Trocar o valor aqui exige trocar também onde as rotinas são agendadas."
      status={configured
        ? <Badge variant="outline" className="border-success/25 bg-success-soft text-success">Segredo configurado</Badge>
        : <Badge variant="outline" className="border-warning/30 bg-warning-soft text-amber-900">Segredo ausente</Badge>}
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
              Trocar segredo
            </Button>
          )}
          {showForm && configured && !dirty && (
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          )}
          <Button asChild variant="link" className="text-accent-foreground">
            <Link to="/saude">Ver Saúde</Link>
          </Button>
        </>
      )}
    >
      <ul aria-label="Rotinas que usam este segredo" className="flex flex-wrap gap-1.5">
        {JOBS.map((job) => (
          <li key={job} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{job}</li>
        ))}
      </ul>
      {showForm && (
        <div className="max-w-lg space-y-1.5">
          <Label htmlFor="internal-job-secret">Segredo dos jobs internos</Label>
          <div className="relative">
            <Input
              id="internal-job-secret"
              type={showSecret ? 'text' : 'password'}
              value={draft.internal_job_secret}
              onChange={(event) => setField('internal_job_secret', event.target.value)}
              placeholder="Segredo usado pelas rotinas automáticas"
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowSecret((current) => !current)}
              aria-label={showSecret ? 'Ocultar segredo' : 'Mostrar segredo'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}
    </SettingsSectionCard>
  );
}
