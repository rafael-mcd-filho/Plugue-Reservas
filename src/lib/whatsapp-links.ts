/** Build a prefilled conversation from an already validated international number. */
export function buildWhatsAppMessageUrl(phoneDigits: string, message: string): string {
  // wa.me's redirect can replace emoji before WhatsApp receives the text.
  return `https://api.whatsapp.com/send?phone=${encodeURIComponent(phoneDigits)}&text=${encodeURIComponent(message)}`;
}
