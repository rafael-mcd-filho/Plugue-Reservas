// Keep provider details in the platform administration while retaining the
// actionable part of payment messages shown to companies and their customers.
export function paymentMessage(
  value: unknown,
  fallback = 'Não foi possível concluir a operação de pagamento.',
): string {
  const detail =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'message' in value
        ? value.message
        : undefined;
  const message = typeof detail === 'string' && detail.trim() ? detail : fallback;
  return message
    .replace(
      /(?:https?:\/\/)?(?:[\w-]+\.)*(?:asaas|assas)\.com(?:\.br)?(?:\/[^\s<>"']*)?/gi,
      'serviço de pagamentos',
    )
    .replace(/\b(?:asaas|assas)[_-][\w-]+\b/gi, 'erro no processamento do pagamento')
    .replace(/\b(?:asaas|assas)\b/gi, 'processador de pagamentos');
}
