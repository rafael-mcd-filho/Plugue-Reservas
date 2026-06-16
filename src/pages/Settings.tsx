import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Save, Upload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSystemSettings, useUpdateSetting } from '@/hooks/useSettings';
import { DEFAULT_SYSTEM_NAME } from '@/lib/branding';

export default function Settings() {
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
    await updateSetting.mutateAsync({ key: 'system_name', value: systemName, silent: true });
    await updateSetting.mutateAsync({ key: 'system_logo_url', value: logoUrl || null, silent: true });
    toast.success('Configurações gerais salvas!');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Selecione um arquivo de imagem (PNG, JPG, SVG, etc.)');
      return;
    }

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
      e.target.value = '';
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Configurações</h1>
          <p className="text-muted-foreground mt-1">Nome e logo exibidos no sistema</p>
        </div>
        <Card className="border-none shadow-sm"><CardContent className="p-6 space-y-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Configurações</h1>
        <p className="text-muted-foreground mt-1">Nome e logo exibidos no sistema</p>
      </div>

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
    </div>
  );
}
