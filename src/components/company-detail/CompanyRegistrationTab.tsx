import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Lock, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/ui/phone-input';
import { supabase } from '@/integrations/supabase/client';
import { useUpdateCompany, type Company } from '@/hooks/useCompanies';
import { normalizePhoneE164 } from '@/lib/phone';
import { isReservedRootSegment } from '@/lib/publicRoutes';
import {
  formatCnpj,
  getCnpjValidationMessage,
  getEmailValidationMessage,
  getPhoneValidationMessage,
  normalizeEmail,
  normalizeOptionalCnpj,
} from '@/lib/validation';
import { cn } from '@/lib/utils';

const MAX_LOGO_FILE_SIZE = 2 * 1024 * 1024;

interface RegistrationForm {
  name: string;
  razao_social: string;
  cnpj: string;
  phone: string;
  email: string;
  logo_url: string;
  responsible_name: string;
  responsible_email: string;
  responsible_phone: string;
  slug: string;
}

function formFromCompany(company: Company): RegistrationForm {
  return {
    name: company.name,
    razao_social: company.razao_social || '',
    cnpj: formatCnpj(company.cnpj),
    phone: normalizePhoneE164(company.phone_e164 ?? company.phone),
    email: company.email || '',
    logo_url: company.logo_url || '',
    responsible_name: company.responsible_name || '',
    responsible_email: company.responsible_email || '',
    responsible_phone: normalizePhoneE164(company.responsible_phone_e164 ?? company.responsible_phone),
    slug: company.slug,
  };
}

function sanitizeSlug(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '');
}

const FIELD_LABELS: Record<keyof RegistrationForm, string> = {
  name: 'nome fantasia',
  razao_social: 'razão social',
  cnpj: 'CNPJ',
  phone: 'telefone',
  email: 'e-mail',
  logo_url: 'logo',
  responsible_name: 'nome do responsável',
  responsible_email: 'e-mail do responsável',
  responsible_phone: 'telefone do responsável',
  slug: 'endereço da página',
};

export default function CompanyRegistrationTab({
  company,
  logoEditable,
  onDirtyChange,
}: {
  company: Company;
  /** O logo segue o recurso de página pública customizada, como no cadastro anterior. */
  logoEditable: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const updateCompany = useUpdateCompany();
  const saved = useMemo(() => formFromCompany(company), [company]);
  const [form, setForm] = useState<RegistrationForm>(saved);
  const [editingSlug, setEditingSlug] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const changedFields = (Object.keys(saved) as Array<keyof RegistrationForm>).filter((key) => form[key] !== saved[key]);
  const dirty = changedFields.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  // Uma atualização vinda do servidor só substitui o formulário quando não há rascunho.
  useEffect(() => {
    if (!dirtyRef.current) {
      setForm(saved);
      setEditingSlug(false);
    }
  }, [saved]);

  const set = (key: keyof RegistrationForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const slugError = form.slug !== saved.slug
    ? !form.slug || form.slug.length < 3
      ? 'Use pelo menos 3 caracteres.'
      : form.slug.endsWith('-')
        ? 'Não termine com hífen.'
        : isReservedRootSegment(form.slug)
          ? 'Esse endereço é usado pelo sistema. Escolha outro.'
          : null
    : null;

  const discard = () => {
    setForm(saved);
    setEditingSlug(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Informe o nome fantasia.'); return; }
    if (slugError) { toast.error(slugError); return; }
    const errors = [
      getCnpjValidationMessage(form.cnpj, 'um CNPJ'),
      getPhoneValidationMessage(form.phone, 'um telefone'),
      getEmailValidationMessage(form.email, 'um e-mail'),
      getEmailValidationMessage(form.responsible_email, 'o e-mail do responsável', false),
      getPhoneValidationMessage(form.responsible_phone, 'o telefone do responsável'),
    ].filter(Boolean);
    if (errors.length) { toast.error(errors[0]!); return; }

    try {
      await updateCompany.mutateAsync({
        id: company.id,
        name: form.name.trim(),
        razao_social: form.razao_social.trim() || null,
        cnpj: normalizeOptionalCnpj(form.cnpj),
        phone: normalizePhoneE164(form.phone),
        email: normalizeEmail(form.email),
        responsible_name: form.responsible_name.trim() || null,
        responsible_email: normalizeEmail(form.responsible_email),
        responsible_phone: normalizePhoneE164(form.responsible_phone),
        logo_url: logoEditable ? form.logo_url : (company.logo_url || ''),
        slug: form.slug,
      } as Partial<Company> & { id: string });
      setEditingSlug(false);
    } catch {
      // useUpdateCompany já mostra o erro; o rascunho continua na tela.
    }
  };

  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Selecione um arquivo de imagem válido.'); return; }
    if (file.size > MAX_LOGO_FILE_SIZE) { toast.error('O logo deve ter no máximo 2 MB.'); return; }
    setUploadingLogo(true);
    try {
      const extension = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const filePath = `company-logos/${company.slug || 'empresa'}-${Date.now()}.${extension}`;
      const { error } = await supabase.storage.from('system-assets').upload(filePath, file, { upsert: false });
      if (error) throw error;
      const { data } = supabase.storage.from('system-assets').getPublicUrl(filePath);
      set('logo_url', data.publicUrl);
      toast.success('Logo enviado. Salve o cadastro para aplicar.');
    } catch (error) {
      toast.error(error instanceof Error ? `Erro ao enviar o logo: ${error.message}` : 'Não foi possível enviar o logo.');
    } finally {
      setUploadingLogo(false);
    }
  };

  return (
    <div className="space-y-4 pb-20">
      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Dados da empresa</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="company-name">Nome fantasia *</Label>
            <Input id="company-name" value={form.name} onChange={(event) => set('name', event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-legal-name">Razão social</Label>
            <Input id="company-legal-name" value={form.razao_social} onChange={(event) => set('razao_social', event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-cnpj">CNPJ</Label>
            <Input id="company-cnpj" value={form.cnpj} onChange={(event) => set('cnpj', event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Telefone</Label>
            <PhoneInput value={form.phone} onChange={(value) => set('phone', value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-email">E-mail</Label>
            <Input id="company-email" type="email" value={form.email} onChange={(event) => set('email', event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Logo</Label>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                {form.logo_url
                  ? <img src={form.logo_url} alt="Logo da empresa" className="h-full w-full object-contain" />
                  : <span className="text-xs text-muted-foreground">—</span>}
              </div>
              {logoEditable ? (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={uploadingLogo} onClick={() => fileInput.current?.click()}>
                    {uploadingLogo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    Trocar
                  </Button>
                  {form.logo_url && (
                    <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => set('logo_url', '')}>
                      <Trash2 className="h-3.5 w-3.5" /> Remover
                    </Button>
                  )}
                  <input ref={fileInput} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-label="Enviar logo" onChange={handleLogoUpload} />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Trocar o logo depende do recurso “Página pública customizada”.</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Responsável</CardTitle>
          <CardDescription>Contato da plataforma com a empresa: avisos, cobrança e suporte.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="responsible-name">Nome</Label>
            <Input id="responsible-name" value={form.responsible_name} onChange={(event) => set('responsible_name', event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="responsible-email">E-mail</Label>
            <Input id="responsible-email" type="email" value={form.responsible_email} onChange={(event) => set('responsible_email', event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Telefone (WhatsApp)</Label>
            <div className={cn(!form.responsible_phone && 'rounded-md ring-1 ring-warning')}>
              <PhoneInput value={form.responsible_phone} onChange={(value) => set('responsible_phone', value)} />
            </div>
            {!form.responsible_phone && (
              <p className="text-xs text-amber-800">Sem esse telefone, a empresa não recebe os avisos da plataforma pelo WhatsApp.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Endereço da página pública</CardTitle>
          <CardDescription>O link que os clientes usam para reservar.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!editingSlug ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm font-medium">
                <Lock aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />/{form.slug}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditingSlug(true)}>Alterar endereço</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="max-w-md space-y-1.5">
                <Label htmlFor="company-slug">Novo endereço</Label>
                <Input id="company-slug" value={form.slug} onChange={(event) => set('slug', sanitizeSlug(event.target.value))} aria-invalid={!!slugError} />
                {slugError && <p className="text-xs text-destructive">{slugError}</p>}
              </div>
              <div role="alert" className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive-soft/60 p-3 text-sm text-destructive">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong className="font-semibold">O link antigo para de funcionar.</strong>{' '}
                  QR codes impressos, a bio do Instagram e links já enviados deixam de abrir a página de reservas.
                </span>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => { set('slug', saved.slug); setEditingSlug(false); }}>
                Manter o endereço atual
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1 basis-80">
          Página pública (descrição, Instagram, WhatsApp, endereço e mapa), horários, regras de reserva e formas de
          pagamento são configurados pela própria empresa.
        </span>
        <Link to={`/empresas?impersonar=${encodeURIComponent(company.id)}&destino=configuracoes`} className="font-semibold text-accent-foreground hover:underline">
          Abrir no painel da empresa →
        </Link>
      </div>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-2 rounded-xl border bg-card px-4 py-3 shadow-lg">
        <span className={cn('mr-auto text-xs', dirty ? 'font-semibold text-amber-900' : 'text-muted-foreground')}>
          {dirty
            ? `${changedFields.length === 1 ? '1 alteração não salva' : `${changedFields.length} alterações não salvas`}: ${changedFields.map((key) => FIELD_LABELS[key]).join(', ')}`
            : 'Nenhuma alteração'}
        </span>
        <Button type="button" variant="outline" disabled={!dirty || updateCompany.isPending} onClick={discard}>Descartar</Button>
        <Button type="button" disabled={!dirty || updateCompany.isPending || !!slugError} onClick={() => void handleSave()} className="gap-2">
          {updateCompany.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Salvar cadastro
        </Button>
      </div>
    </div>
  );
}
