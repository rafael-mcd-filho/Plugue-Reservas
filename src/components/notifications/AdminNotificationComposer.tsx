import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ImagePlus, Loader2, MessageCircle, Search, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import RichTextEditor from '@/components/RichTextEditor';
import { useCreateNotification } from '@/hooks/useSettings';
import type { Company } from '@/hooks/useCompanies';
import { useCreatePlatformWhatsAppNotice } from '@/hooks/usePlatformWhatsAppNotices';
import { getCompanyNoticeContact, uploadNoticeImage } from '@/lib/platform-whatsapp-notices';
import { formatPhone } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

export type NotificationChannel = 'panel' | 'whatsapp';

/** Conteúdo para abrir o formulário já preenchido (duplicar um envio). */
export interface NotificationDraft {
  channel: NotificationChannel;
  title?: string;
  message?: string;
  type?: string;
  imageUrl?: string | null;
  caption?: string;
  image?: { path: string; url: string } | null;
  companyIds?: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: Company[];
  companiesLoading?: boolean;
  companiesError?: boolean;
  onRetryCompanies?: () => void;
  onCreated: (channel: NotificationChannel) => void;
  initialDraft?: NotificationDraft | null;
}
const emptyPanel = { title: '', message: '', image_url: '', type: 'info' };
const readableMessage = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim();
const typeLabels: Record<string, string> = { info: 'Informação', warning: 'Aviso', success: 'Sucesso', error: 'Erro' };
const typeTones: Record<string, string> = {
  info: 'border-info/30 bg-info-soft text-info',
  warning: 'border-warning/30 bg-warning-soft text-amber-900',
  success: 'border-success/30 bg-success-soft text-success',
  error: 'border-destructive/30 bg-destructive-soft text-destructive',
};

export default function AdminNotificationComposer({ open, onOpenChange, companies, companiesLoading, companiesError, onRetryCompanies, onCreated, initialDraft }: Props) {
  const createPanel = useCreateNotification();
  const createWhatsApp = useCreatePlatformWhatsAppNotice();
  const [channel, setChannel] = useState<NotificationChannel>('panel');
  const [panel, setPanel] = useState(emptyPanel);
  const [caption, setCaption] = useState('');
  const [image, setImage] = useState<{ path: string; url: string } | null>(null);
  const [sendToAll, setSendToAll] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [companySearch, setCompanySearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const appliedDraft = useRef<NotificationDraft | null>(null);
  const sending = createPanel.isPending || createWhatsApp.isPending;
  const targets = sendToAll ? companies : companies.filter(company => selectedIds.includes(company.id));
  const eligiblePhones = new Set(targets.map(company => getCompanyNoticeContact(company).phone).filter(Boolean));
  const missingContacts = targets.filter(company => !getCompanyNoticeContact(company).phone).length;
  const imageUrl = channel === 'whatsapp' ? image?.url : panel.image_url.trim();
  const valid = !companiesError && !companiesLoading && !imageError && targets.length > 0 && (channel === 'panel'
    ? !!panel.title.trim() && !!readableMessage(panel.message)
    : !!image && !!caption.trim() && caption.length <= 1000 && eligiblePhones.size > 0);
  const visibleCompanies = useMemo(() => {
    const query = companySearch.trim().toLocaleLowerCase('pt-BR');
    return query ? companies.filter(company => company.name.toLocaleLowerCase('pt-BR').includes(query)) : companies;
  }, [companies, companySearch]);

  useEffect(() => {
    if (!open || !initialDraft || appliedDraft.current === initialDraft) return;
    appliedDraft.current = initialDraft;
    setChannel(initialDraft.channel);
    setSendError(null); setImageError(null); setConfirming(false); request.current = null;
    if (initialDraft.channel === 'panel') {
      setPanel({
        title: initialDraft.title ?? '',
        message: initialDraft.message ?? '',
        image_url: initialDraft.imageUrl ?? '',
        type: initialDraft.type ?? 'info',
      });
    } else {
      setCaption(initialDraft.caption ?? '');
      setImage(initialDraft.image ?? null);
    }
    if (initialDraft.companyIds?.length) { setSendToAll(false); setSelectedIds(initialDraft.companyIds); }
    else { setSendToAll(initialDraft.channel === 'panel'); setSelectedIds([]); }
  }, [initialDraft, open]);

  function changeChannel(next: NotificationChannel) {
    setChannel(next); setSendError(null); setImageError(null); setConfirming(false);
    // Sending a WhatsApp starts with an explicit recipient selection.
    if (next === 'whatsapp' && sendToAll) { setSendToAll(false); setSelectedIds([]); }
  }
  function toggleCompany(id: string) {
    setConfirming(false);
    setSelectedIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  }
  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const targetChannel = channel;
    setUploading(true); setImageError(null);
    try {
      if (targetChannel === 'whatsapp') setImage(await uploadNoticeImage(file));
      else {
        if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) throw new Error('Selecione uma imagem de até 10 MB.');
        const extension = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `notification-images/${crypto.randomUUID()}.${extension}`;
        const { error } = await supabase.storage.from('system-assets').upload(path, file, { upsert: false, contentType: file.type });
        if (error) throw error;
        const { data } = supabase.storage.from('system-assets').getPublicUrl(path);
        setPanel(value => ({ ...value, image_url: data.publicUrl }));
      }
    } catch (error) { setImageError(error instanceof Error ? error.message : 'Não foi possível carregar a imagem.'); }
    finally { setUploading(false); event.target.value = ''; }
  }
  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || sending || uploading) return;
    // A send to several companies asks for one confirmation with the reach.
    if (targets.length > 1 && !confirming) { setConfirming(true); return; }
    setSendError(null);
    try {
      if (channel === 'panel') {
        await createPanel.mutateAsync({ company_ids: targets.map(company => company.id), ...panel, title: panel.title.trim(), image_url: panel.image_url.trim() || null });
      } else {
        const ids = targets.map(company => company.id).sort();
        const fingerprint = JSON.stringify([ids, image!.path, caption.trim()]);
        if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
        await createWhatsApp.mutateAsync({ request_id: request.current.id, company_ids: ids, image_path: image!.path, caption: caption.trim() });
        toast.success('Envio registrado. Acompanhe o andamento na lista de avisos.');
      }
      onCreated(channel); onOpenChange(false);
      setPanel(emptyPanel); setCaption(''); setImage(null); setSelectedIds([]); setSendToAll(channel === 'panel'); setCompanySearch(''); setConfirming(false);
      request.current = null; appliedDraft.current = null;
    } catch (error) { setSendError(error instanceof Error ? error.message : 'Não foi possível registrar o aviso. Tente novamente.'); }
  }

  const reachSummary = channel === 'whatsapp'
    ? `${targets.length} ${targets.length === 1 ? 'empresa' : 'empresas'} · ${eligiblePhones.size} ${eligiblePhones.size === 1 ? 'contato válido' : 'contatos válidos'}`
    : `${targets.length} ${targets.length === 1 ? 'empresa' : 'empresas'}`;

  return <Dialog open={open} onOpenChange={next => { if (!sending && !uploading) { onOpenChange(next); if (!next) setConfirming(false); } }}>
    <DialogContent className="flex max-h-[90dvh] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
      <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12 sm:px-6">
        <DialogTitle>Novo aviso</DialogTitle>
        <DialogDescription>Escolha o canal e as empresas que receberão o aviso.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSend} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-5 px-5 py-4 sm:px-6">
            <fieldset className="space-y-2" disabled={sending || uploading}>
              <legend className="mb-2 text-sm font-medium">Canal do aviso</legend>
              <RadioGroup value={channel} onValueChange={value => changeChannel(value as NotificationChannel)} className="grid grid-cols-2 gap-2">
                {([{ value: 'panel', label: 'Painel', detail: 'Aviso no sistema', icon: Bell }, { value: 'whatsapp', label: 'WhatsApp', detail: 'Imagem e legenda', icon: MessageCircle }] as const).map(option => <Label key={option.value} htmlFor={`notice-channel-${option.value}`} className={cn('flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors', channel === option.value ? 'border-primary bg-primary-soft/50' : 'border-border hover:bg-muted/40')}>
                  <RadioGroupItem id={`notice-channel-${option.value}`} value={option.value} className="mt-0.5 shrink-0"/>
                  <div className="min-w-0 space-y-1"><span className="flex items-center gap-1.5 text-sm font-semibold"><option.icon aria-hidden="true" className="h-4 w-4"/>{option.label}</span><span className="block text-xs font-normal text-muted-foreground">{option.detail}</span></div>
                </Label>)}
              </RadioGroup>
            </fieldset>
            <fieldset className="space-y-2" disabled={sending}>
              <legend className="mb-2 text-sm font-medium">Destinatários</legend>
              {companiesError ? <div role="alert" className="rounded-md border border-destructive/20 p-3 text-sm">Não foi possível carregar as empresas.<Button type="button" variant="outline" size="sm" className="ml-2" onClick={onRetryCompanies}>Tentar novamente</Button></div>
                : companiesLoading ? <p role="status" className="text-sm text-muted-foreground">Carregando empresas…</p>
                : <>
                  <div className="flex items-center gap-2"><Checkbox id="notice-send-all" checked={sendToAll} onCheckedChange={value => { setSendToAll(value === true); setSelectedIds([]); setConfirming(false); }}/><label htmlFor="notice-send-all" className="cursor-pointer text-sm">Todas as empresas ({companies.length})</label></div>
                  {!sendToAll && <div className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"/>
                        <Input value={companySearch} onChange={event => setCompanySearch(event.target.value)} placeholder="Buscar empresa" aria-label="Buscar empresa" className="h-8 pl-8 text-sm"/>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">{selectedIds.length} {selectedIds.length === 1 ? 'selecionada' : 'selecionadas'}</span>
                    </div>
                    <div className="max-h-44 space-y-2 overflow-y-auto">
                      {visibleCompanies.length === 0 ? <p className="text-sm text-muted-foreground">{companies.length === 0 ? 'Nenhuma empresa cadastrada.' : 'Nenhuma empresa com esse nome.'}</p> : visibleCompanies.map(company => {
                        const contact = getCompanyNoticeContact(company);
                        return <div key={company.id} className="flex items-start gap-2"><Checkbox id={`notice-company-${company.id}`} className="mt-0.5" checked={selectedIds.includes(company.id)} onCheckedChange={() => toggleCompany(company.id)}/><label htmlFor={`notice-company-${company.id}`} className="min-w-0 cursor-pointer text-sm"><span className="block">{company.name}</span>{channel === 'whatsapp' && <span className="block text-xs text-muted-foreground">{contact.phone ? formatPhone(contact.phone) : 'Sem telefone válido do responsável'}</span>}</label></div>;
                      })}
                    </div>
                  </div>}
                </>}
              {channel === 'whatsapp' && <div className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                <p>Envio pela <strong className="font-medium text-foreground">RWSL</strong> para o telefone do responsável cadastrado na empresa.</p>
                <p>{eligiblePhones.size} {eligiblePhones.size === 1 ? 'contato receberá' : 'contatos receberão'} a imagem.{missingContacts > 0 && ` ${missingContacts} ${missingContacts === 1 ? 'empresa sem contato válido será registrada' : 'empresas sem contato válido serão registradas'} como não enviada${missingContacts === 1 ? '' : 's'}.`}</p>
                <p>Um mesmo número recebe o aviso uma única vez neste envio.</p>
              </div>}
            </fieldset>
            {channel === 'panel' && <>
              <div className="space-y-1.5"><Label htmlFor="notice-type">Tipo</Label><Select value={panel.type} onValueChange={type => setPanel(value => ({ ...value, type }))} disabled={sending}><SelectTrigger id="notice-type"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="info">Informação</SelectItem><SelectItem value="warning">Aviso</SelectItem><SelectItem value="success">Sucesso</SelectItem><SelectItem value="error">Erro</SelectItem></SelectContent></Select></div>
              <div className="space-y-1.5"><Label htmlFor="notice-title">Título *</Label><Input id="notice-title" value={panel.title} onChange={event => setPanel(value => ({ ...value, title: event.target.value }))} placeholder="Título do aviso" disabled={sending}/></div>
              <div className="space-y-1.5"><Label>Mensagem *</Label><RichTextEditor content={panel.message} onChange={message => setPanel(value => ({ ...value, message }))} placeholder="Escreva a mensagem do aviso…"/></div>
            </>}
            <div className="space-y-2">
              <Label htmlFor={channel === 'panel' ? 'notice-image-url' : 'notice-image-file'}>Imagem {channel === 'whatsapp' ? '*' : '(opcional)'}</Label>
              <div className="flex items-center gap-2">
                {channel === 'panel' && <Input id="notice-image-url" value={panel.image_url} onChange={event => setPanel(value => ({ ...value, image_url: event.target.value }))} placeholder="Cole uma URL ou escolha uma imagem" disabled={sending || uploading} className="min-w-0 flex-1"/>}
                <Button type="button" variant="outline" className="shrink-0 gap-1.5" onClick={() => fileInput.current?.click()} disabled={sending || uploading}>{uploading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin"/> : <ImagePlus aria-hidden="true" className="h-4 w-4"/>}{uploading ? 'Carregando…' : imageUrl ? 'Trocar imagem' : 'Escolher imagem'}</Button>
                <input ref={fileInput} id="notice-image-file" type="file" aria-label="Selecionar imagem do aviso" accept={channel === 'whatsapp' ? 'image/jpeg,image/png' : 'image/*'} onChange={handleUpload} disabled={sending || uploading} className="sr-only" tabIndex={-1}/>
                {imageUrl && <Button type="button" variant="ghost" size="icon" aria-label="Remover imagem" disabled={sending || uploading} onClick={() => { if (channel === 'whatsapp') setImage(null); else setPanel(value => ({ ...value, image_url: '' })); setImageError(null); }}><X aria-hidden="true" className="h-4 w-4"/></Button>}
              </div>
              {channel === 'whatsapp' && <p className="text-xs text-muted-foreground">PNG ou JPG, até 5 MB.</p>}
              {imageError && <p role="alert" className="text-sm text-destructive">{imageError}</p>}
            </div>
            {channel === 'whatsapp' && <div className="space-y-1.5"><Label htmlFor="notice-caption">Legenda *</Label><Textarea id="notice-caption" value={caption} onChange={event => setCaption(event.target.value)} rows={4} maxLength={1000} placeholder="Escreva a legenda que acompanhará a imagem" disabled={sending}/><p className="text-right text-xs tabular-nums text-muted-foreground">{caption.length}/1.000</p></div>}
            {sendError && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive-soft p-3 text-sm text-destructive">{sendError}</p>}
          </div>
          <details open className="border-t border-border bg-muted/20 px-5 py-4 sm:px-6 lg:border-l lg:border-t-0">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground lg:pointer-events-none lg:list-none">Como a empresa recebe</summary>
            <div className="mt-3 overflow-hidden rounded-lg border bg-card text-sm">
              {imageUrl && <img key={imageUrl} src={imageUrl} alt="Prévia da imagem do aviso" className="max-h-44 w-full bg-muted/30 object-contain" onError={() => setImageError('Não foi possível exibir a imagem selecionada.')}/>}
              <div className="space-y-2 p-3">
                {channel === 'panel' ? <>
                  <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium', typeTones[panel.type] ?? typeTones.info)}>{typeLabels[panel.type] ?? 'Informação'}</span>
                  <p className="font-semibold">{panel.title.trim() || 'Título do aviso'}</p>
                  {readableMessage(panel.message)
                    ? <div className="prose prose-sm max-w-none text-sm text-muted-foreground [&_p]:my-1" dangerouslySetInnerHTML={{ __html: panel.message }}/>
                    : <p className="text-muted-foreground">A mensagem aparece aqui.</p>}
                </> : <p className="whitespace-pre-wrap break-words">{caption.trim() || 'A legenda aparece aqui.'}</p>}
              </div>
            </div>
          </details>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4 sm:px-6">
          {confirming && <p role="status" className="mr-auto text-sm text-amber-900">Confirme o envio para {reachSummary}.</p>}
          <Button type="button" variant="outline" onClick={() => { if (confirming) setConfirming(false); else onOpenChange(false); }} disabled={sending || uploading}>{confirming ? 'Voltar' : 'Cancelar'}</Button>
          <Button type="submit" className="gap-1.5" disabled={!valid || sending || uploading}>{sending ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin"/> : <Send aria-hidden="true" className="h-4 w-4"/>}{sending ? 'Registrando…' : confirming ? `Confirmar envio para ${targets.length} empresas` : channel === 'whatsapp' ? 'Enviar pelo WhatsApp' : 'Enviar aviso'}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
