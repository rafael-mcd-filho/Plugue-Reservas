import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Upload } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSaveSettings, type SystemSetting } from '@/hooks/useSettings';
import { DEFAULT_SYSTEM_NAME } from '@/lib/branding';
import SettingsSectionCard from './SettingsSectionCard';
import { useSettingsDraft } from './useSettingsDraft';

const KEYS = ['system_name', 'system_logo_url'] as const;

export default function SystemBrandingCard({ settings }: { settings: SystemSetting[] }) {
  const saveSettings = useSaveSettings();
  const { draft, dirty, setField, discard } = useSettingsDraft(settings, KEYS);
  const [uploading, setUploading] = useState(false);

  const handleSave = async () => {
    try {
      await saveSettings.mutateAsync({
        system_name: draft.system_name.trim() || null,
        system_logo_url: draft.system_logo_url.trim() || null,
      });
      toast.success('Identidade da plataforma salva.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar. Nada foi alterado.');
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Selecione um arquivo de imagem (PNG, JPG, SVG etc.).');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('O arquivo deve ter no máximo 2 MB.');
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
      const { data } = supabase.storage.from('system-assets').getPublicUrl(fileName);
      setField('system_logo_url', data.publicUrl);
      toast.success('Logo enviado. Salve para aplicar.');
    } catch (error) {
      toast.error(error instanceof Error ? `Erro ao enviar: ${error.message}` : 'Não foi possível enviar o logo.');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  return (
    <SettingsSectionCard
      title="Identidade da plataforma"
      description="Nome e logo exibidos no menu, no login e no ícone do navegador."
      dirty={dirty}
      saving={saveSettings.isPending}
      onSave={handleSave}
      onDiscard={discard}
      saveDisabled={uploading}
    >
      <div className="grid max-w-md gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="system-name">Nome do sistema</Label>
          <Input
            id="system-name"
            value={draft.system_name}
            onChange={(event) => setField('system_name', event.target.value)}
            placeholder={DEFAULT_SYSTEM_NAME}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="system-logo">Logo</Label>
          <div className="flex gap-2">
            <Input
              id="system-logo"
              value={draft.system_logo_url}
              onChange={(event) => setField('system_logo_url', event.target.value)}
              placeholder="https://exemplo.com/logo.png"
              className="flex-1"
            />
            <Button asChild variant="outline" size="icon" disabled={uploading}>
              <label className="cursor-pointer" aria-label="Enviar arquivo de logo">
                <input type="file" accept="image/*" onChange={handleFileUpload} className="sr-only" />
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              </label>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Cole uma URL ou envie um arquivo de até 2 MB.</p>
          <div className="flex min-h-[64px] items-center justify-center rounded-lg bg-muted p-4">
            {draft.system_logo_url ? (
              <img
                src={draft.system_logo_url}
                alt="Prévia do logo"
                className="max-h-16 object-contain"
                onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <p className="text-xs text-muted-foreground">A prévia do logo aparece aqui.</p>
            )}
          </div>
        </div>
      </div>
    </SettingsSectionCard>
  );
}
