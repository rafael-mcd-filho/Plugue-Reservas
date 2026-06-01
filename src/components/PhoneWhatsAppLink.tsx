import { type MouseEvent, type SVGProps, useMemo, useState } from 'react';
import { ExternalLink, Loader2, MessageCircle } from 'lucide-react';
import { useAutomationSettings } from '@/hooks/useAutomations';
import {
  RESERVATION_WHATSAPP_AUTOMATIONS,
  renderReservationWhatsAppTemplate,
} from '@/lib/whatsapp-automations';
import { cn } from '@/lib/utils';
import { formatBrazilPhone, normalizeBrazilPhoneDigits, toBrazilWhatsAppNumber } from '@/lib/validation';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

function WhatsAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M12 2.25a9.75 9.75 0 0 0-8.35 14.78L2.3 21.7l4.84-1.27A9.75 9.75 0 1 0 12 2.25Z"
      />
      <path
        fill="white"
        d="M9.25 6.65c-.23 0-.45.11-.63.31-.31.33-.82.83-.82 1.94s.81 2.18.92 2.33c.11.14 1.58 2.52 3.83 3.44 1.87.75 2.25.6 2.66.56.41-.04 1.32-.54 1.51-1.06.19-.53.19-.97.13-1.06-.05-.09-.19-.15-.39-.25-.2-.1-1.16-.57-1.34-.64-.18-.06-.31-.09-.45.12-.13.2-.52.63-.63.77-.12.13-.24.15-.43.05-.2-.1-.84-.31-1.6-1-.59-.53-.99-1.19-1.12-1.39-.12-.2-.02-.3.09-.4.09-.09.2-.23.3-.34.1-.11.13-.2.2-.32.07-.13.03-.25-.01-.34-.05-.1-.44-1.12-.61-1.53-.16-.39-.33-.4-.45-.4h-.38Z"
      />
    </svg>
  );
}

interface PhoneWhatsAppLinkProps {
  phone: string | null | undefined;
  companyId?: string | null;
  slug?: string | null;
  reservation?: {
    guest_name?: string | null;
    guest_phone?: string | null;
    date?: string | null;
    time?: string | null;
    party_size?: number | null;
    public_tracking_code?: string | null;
  } | null;
  className?: string;
  phoneClassName?: string;
  iconClassName?: string;
  linkClassName?: string;
  stopPropagation?: boolean;
  linkMode?: 'anchor' | 'button';
}

export default function PhoneWhatsAppLink({
  phone,
  companyId,
  slug,
  reservation,
  className,
  phoneClassName,
  iconClassName,
  linkClassName,
  stopPropagation = true,
  linkMode = 'anchor',
}: PhoneWhatsAppLinkProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { data: automationSettings, isLoading, isError } = useAutomationSettings(companyId ?? undefined, pickerOpen);
  const formattedPhone = formatBrazilPhone(phone);
  const digits = normalizeBrazilPhoneDigits(phone);
  const whatsappNumber = digits.length >= 10 ? toBrazilWhatsAppNumber(digits) : '';
  const whatsappUrl = whatsappNumber ? `https://wa.me/${whatsappNumber}` : '';
  const hasMessagePicker = Boolean(companyId && reservation);
  const trackingUrl =
    typeof window !== 'undefined' && slug && reservation?.public_tracking_code
      ? `${window.location.origin}/${slug}/reserva/${reservation.public_tracking_code}`
      : '';
  const messageOptions = useMemo(() => {
    const settingsByType = new Map(automationSettings?.map((setting) => [setting.type, setting]));

    return RESERVATION_WHATSAPP_AUTOMATIONS.map((automation) => {
      const setting = settingsByType.get(automation.type);
      const savedTemplate = setting?.message_template?.trim();
      const template = savedTemplate || automation.defaultTemplate;

      return {
        ...automation,
        enabled: setting?.enabled ?? false,
        isDefault: !savedTemplate,
        message: renderReservationWhatsAppTemplate(template, {
          guestName: reservation?.guest_name,
          guestPhone: reservation?.guest_phone ?? phone,
          date: reservation?.date,
          time: reservation?.time,
          partySize: reservation?.party_size,
          trackingUrl,
        }),
      };
    });
  }, [automationSettings, phone, reservation, trackingUrl]);

  if (!formattedPhone) return null;

  const handleInteraction = (event: MouseEvent<HTMLElement>) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const openWhatsApp = (message?: string) => {
    if (!whatsappUrl || typeof window === 'undefined') return;
    const text = message?.trim();
    const targetUrl = text ? `${whatsappUrl}?text=${encodeURIComponent(text)}` : whatsappUrl;
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
    setPickerOpen(false);
  };

  const handleButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    handleInteraction(event);
    if (hasMessagePicker) {
      setPickerOpen(true);
      return;
    }
    openWhatsApp();
  };

  const icon = (
    <WhatsAppIcon
      className={cn(
        'h-3.5 w-3.5 -translate-y-px text-[#25D366] transition-transform duration-200 group-hover/wa:scale-110',
        iconClassName,
      )}
    />
  );

  return (
    <>
      <span className={cn('inline-flex items-center gap-1.5', className)}>
        <span className={cn('tabular-nums leading-none', phoneClassName)}>{formattedPhone}</span>
        {whatsappUrl ? (
          hasMessagePicker || linkMode === 'button' ? (
            <button
              type="button"
              onClick={handleButtonClick}
              aria-label={`Abrir WhatsApp de ${formattedPhone}`}
              title="Abrir WhatsApp"
              className={cn(
                'group/wa inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[#25D366] opacity-90 transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                linkClassName,
              )}
            >
              {icon}
            </button>
          ) : (
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleInteraction}
              aria-label={`Abrir WhatsApp de ${formattedPhone}`}
              title="Abrir WhatsApp"
              className={cn(
                'group/wa inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[#25D366] opacity-90 transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                linkClassName,
              )}
            >
              {icon}
            </a>
          )
        ) : null}
      </span>

      {hasMessagePicker && (
        <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
          <DialogContent className="max-h-[calc(100vh-1.5rem)] overflow-hidden p-0 sm:max-w-md">
            <DialogHeader className="border-b border-border/70 px-4 pb-3 pt-4 pr-14 text-left">
              <DialogTitle className="text-base">Abrir conversa no WhatsApp</DialogTitle>
              <DialogDescription>
                Escolha uma mensagem cadastrada para preencher a conversa com {reservation?.guest_name || formattedPhone}.
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[min(58vh,26rem)] space-y-1.5 overflow-y-auto px-4 py-3">
              {isLoading ? (
                <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Carregando mensagens...
                </div>
              ) : isError ? (
                <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  Não foi possível carregar as mensagens cadastradas. Você ainda pode abrir uma conversa sem texto.
                </div>
              ) : (
                messageOptions.map((option) => {
                  const Icon = option.icon;

                  return (
                    <button
                      key={option.type}
                      type="button"
                      onClick={() => openWhatsApp(option.message)}
                      className="group flex w-full items-center gap-2.5 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left transition hover:border-[#25D366]/45 hover:bg-[#25D366]/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366]/60 focus-visible:ring-offset-2"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#25D366]/10 text-[#168a42]">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">{option.label}</span>
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                              option.enabled
                                ? 'bg-[#25D366]/10 text-[#168a42]'
                                : 'bg-muted text-muted-foreground',
                            )}
                          >
                            {option.enabled ? 'Ativa' : option.isDefault ? 'Texto padrão' : 'Inativa'}
                          </span>
                        </span>
                      </span>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition group-hover:text-[#168a42]" />
                    </button>
                  );
                })
              )}
            </div>

            <div className="border-t border-border/70 bg-muted/20 px-4 py-3">
              <button
                type="button"
                onClick={() => openWhatsApp()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <MessageCircle className="h-4 w-4 text-[#168a42]" />
                Abrir conversa sem mensagem
              </button>
              <p className="mt-1.5 text-center text-[10px] leading-relaxed text-muted-foreground">
                A conversa será aberta para revisão. Nenhuma mensagem é enviada automaticamente por esta ação.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
