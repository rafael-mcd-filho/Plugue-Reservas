import { type MouseEvent, type SVGProps } from 'react';
import { cn } from '@/lib/utils';
import { formatBrazilPhone, normalizeBrazilPhoneDigits, toBrazilWhatsAppNumber } from '@/lib/validation';

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
  className?: string;
  phoneClassName?: string;
  iconClassName?: string;
  linkClassName?: string;
  stopPropagation?: boolean;
  linkMode?: 'anchor' | 'button';
}

export default function PhoneWhatsAppLink({
  phone,
  className,
  phoneClassName,
  iconClassName,
  linkClassName,
  stopPropagation = true,
  linkMode = 'anchor',
}: PhoneWhatsAppLinkProps) {
  const formattedPhone = formatBrazilPhone(phone);
  const digits = normalizeBrazilPhoneDigits(phone);
  const whatsappNumber = digits.length >= 10 ? toBrazilWhatsAppNumber(digits) : '';
  const whatsappUrl = whatsappNumber ? `https://wa.me/${whatsappNumber}` : '';

  if (!formattedPhone) return null;

  const handleInteraction = (event: MouseEvent<HTMLElement>) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const handleButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    handleInteraction(event);
    if (!whatsappUrl || typeof window === 'undefined') return;
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
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
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('tabular-nums leading-none', phoneClassName)}>{formattedPhone}</span>
      {whatsappUrl ? (
        linkMode === 'button' ? (
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
  );
}
