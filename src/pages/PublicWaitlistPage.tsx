import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Clock3, MapPin, MessageSquare, Phone, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { removePublicCompanyIcons, syncPublicCompanyIcons } from '@/lib/publicCompanyIcons';
import { getVisitorId } from '@/hooks/useFunnelTracking';
import type { Company } from '@/hooks/useCompanies';
import {
  formatBrazilPhone,
  isValidBrazilWhatsApp,
  isValidCompanySlug,
  MAX_WAITLIST_NAME_LENGTH,
  MAX_WAITLIST_NOTES_LENGTH,
  normalizeBrazilPhoneDigits,
} from '@/lib/validation';

const DISABLED_MESSAGE = 'A entrada online na fila de espera está indisponível no momento. Dirija-se à unidade para entrar na fila de espera.';

export default function PublicWaitlistPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const slugIsValid = isValidCompanySlug(slug);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    guestName: '',
    guestPhone: '',
    partySize: 2,
    notes: '',
  });

  const { data: company, isLoading, error } = useQuery({
    queryKey: ['company-public', slug],
    queryFn: async () => {
      const fetchPublicCompanyFromView = async () => {
        const { data, error } = await supabase
          .from('companies_public' as any)
          .select('*')
          .eq('slug', slug!)
          .maybeSingle();

        if (error) throw error;
        return data as Company | null;
      };

      const rpcResult = await (supabase as any).rpc('get_public_company_by_slug', { _slug: slug! });

      if (!rpcResult.error) {
        const rows = (rpcResult.data ?? []) as Company[];
        const row = rows.length > 0 ? rows[0] : null;

        if (row && !Object.prototype.hasOwnProperty.call(row, 'public_waitlist_enabled')) {
          return fetchPublicCompanyFromView();
        }

        return row;
      }

      return fetchPublicCompanyFromView();
    },
    enabled: slugIsValid,
  });

  const queueEnabled = company?.public_waitlist_enabled ?? false;
  const companyTitle = company?.name || slug || 'Fila de espera';
  const helperText = useMemo(
    () => queueEnabled
      ? 'Preencha seus dados para entrar na fila. Depois você será redirecionado para a página de acompanhamento.'
      : DISABLED_MESSAGE,
    [queueEnabled],
  );

  useEffect(() => {
    syncPublicCompanyIcons(company?.logo_url);
    return () => removePublicCompanyIcons();
  }, [company?.logo_url]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!slug || !slugIsValid) return;

    const guestName = form.guestName.trim();
    const guestPhone = normalizeBrazilPhoneDigits(form.guestPhone);
    const notes = form.notes.trim();

    if (!guestName) {
      toast.error('Informe seu nome.');
      return;
    }

    if (guestName.length > MAX_WAITLIST_NAME_LENGTH) {
      toast.error(`O nome deve ter no máximo ${MAX_WAITLIST_NAME_LENGTH} caracteres.`);
      return;
    }

    if (!isValidBrazilWhatsApp(guestPhone)) {
      toast.error('Informe um WhatsApp válido com DDD.');
      return;
    }

    if (notes.length > MAX_WAITLIST_NOTES_LENGTH) {
      toast.error(`As observações devem ter no máximo ${MAX_WAITLIST_NOTES_LENGTH} caracteres.`);
      return;
    }

    setSubmitting(true);

    try {
      const { data, error } = await (supabase as any).rpc('join_public_waitlist', {
        _slug: slug,
        _guest_name: guestName,
        _guest_phone: guestPhone,
        _party_size: form.partySize,
        _notes: notes || null,
        _visitor_id: getVisitorId(),
      });

      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.tracking_code) {
        throw new Error('Não foi possível criar a entrada na fila.');
      }

      if (row.already_exists) {
        toast.info('Você já está na fila. Redirecionando para o acompanhamento...');
      } else {
        toast.success('Entrada na fila criada com sucesso!');
        supabase.functions.invoke('reservation-events', {
          body: {
            event: 'waitlist_added',
            waitlist: {
              id: row.id,
            },
          },
        }).catch((invokeError) => {
          console.warn('Public waitlist notification error:', invokeError);
        });
      }

      navigate(`/${slug}/fila/${row.tracking_code}`, { replace: true });
    } catch (submitError: any) {
      toast.error(submitError.message || 'Não foi possível entrar na fila agora.');
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!slugIsValid || error || !company) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md border border-border shadow-sm">
          <CardContent className="space-y-4 py-10 text-center">
            <MapPin className="mx-auto h-12 w-12 text-muted-foreground" />
            <div className="space-y-1">
              <h1 className="text-xl font-semibold tracking-tight">Link indisponível</h1>
              <p className="text-sm text-muted-foreground">
                Esta unidade não foi encontrada ou está temporariamente indisponível.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-md space-y-6">
        <div className="space-y-3 text-center">
          {company.logo_url ? (
            <img src={company.logo_url} alt={companyTitle} className="mx-auto h-14 w-14 rounded-full object-cover" />
          ) : (
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
              {companyTitle.charAt(0)}
            </div>
          )}
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-primary/70">Fila de espera</p>
            <h1 className="text-2xl font-semibold tracking-tight">{companyTitle}</h1>
            <p className="text-sm text-muted-foreground">{helperText}</p>
          </div>
        </div>

        <Card className="border border-border shadow-sm">
          <CardContent className="space-y-5 p-5">
            {queueEnabled ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="waitlist-guest-name">Nome</Label>
                  <Input
                    id="waitlist-guest-name"
                    name="guest_name"
                    value={form.guestName}
                    onChange={(event) => setForm((current) => ({ ...current, guestName: event.target.value }))}
                    placeholder="Seu nome"
                    autoComplete="name"
                    maxLength={MAX_WAITLIST_NAME_LENGTH}
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="waitlist-guest-phone" className="flex items-center gap-1.5">
                    <Phone className="h-4 w-4" />
                    WhatsApp
                  </Label>
                  <Input
                    id="waitlist-guest-phone"
                    name="guest_phone"
                    type="tel"
                    value={form.guestPhone}
                    onChange={(event) => setForm((current) => ({ ...current, guestPhone: formatBrazilPhone(event.target.value) }))}
                    placeholder="(11) 99999-9999"
                    autoComplete="tel"
                    inputMode="tel"
                    spellCheck={false}
                    maxLength={15}
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="waitlist-party-size" className="flex items-center gap-1.5">
                    <Users className="h-4 w-4" />
                    Quantidade de pessoas
                  </Label>
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      aria-label="Diminuir quantidade de pessoas"
                      onClick={() => setForm((current) => ({ ...current, partySize: Math.max(1, current.partySize - 1) }))}
                    >
                      -
                    </Button>
                    <span
                      id="waitlist-party-size"
                      aria-live="polite"
                      className="flex h-9 w-14 items-center justify-center rounded-md border border-input bg-background text-sm font-semibold tabular-nums"
                    >
                      {form.partySize}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      aria-label="Aumentar quantidade de pessoas"
                      onClick={() => setForm((current) => ({ ...current, partySize: Math.min(20, current.partySize + 1) }))}
                    >
                      +
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="waitlist-notes" className="flex items-center gap-1.5">
                    <MessageSquare className="h-4 w-4" />
                    Observações
                  </Label>
                  <Textarea
                    id="waitlist-notes"
                    name="notes"
                    value={form.notes}
                    onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                    placeholder="Ex: crianca, cadeira de bebe, preferencia de mesa..."
                    autoComplete="off"
                    rows={3}
                    maxLength={MAX_WAITLIST_NOTES_LENGTH}
                  />
                </div>

                <Button type="submit" className="w-full gap-2" disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Entrar na fila
                </Button>
              </form>
            ) : (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
                  <Clock3 className="h-5 w-5" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-semibold tracking-tight">Entrada online indisponível</h2>
                  <p className="text-sm text-muted-foreground">{DISABLED_MESSAGE}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
