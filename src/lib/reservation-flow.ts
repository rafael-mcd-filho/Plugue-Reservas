import { toBrazilWhatsAppNumber } from '@/lib/validation';

export const LARGE_PARTY_SIZE = 10;
export const LARGE_PARTY_WHATSAPP_MESSAGE = 'Oi, vim pelo site e preciso de uma reserva a partir de 10 pessoas';

export function isLargePartyReservation(partySize: number) {
  return partySize >= LARGE_PARTY_SIZE;
}

export function buildLargePartyWhatsappUrl(companyWhatsapp: string | null | undefined) {
  const whatsappNumber = toBrazilWhatsAppNumber(companyWhatsapp);
  if (!whatsappNumber) {
    return null;
  }

  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(LARGE_PARTY_WHATSAPP_MESSAGE)}`;
}
