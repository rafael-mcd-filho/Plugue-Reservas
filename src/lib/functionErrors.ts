import { normalizePasswordValidationMessage } from '@/lib/validation';

export async function getFunctionErrorMessage(error: any) {
  if (error?.context) {
    const response = error.context;
    const responseClone = typeof response.clone === 'function' ? response.clone() : null;

    try {
      const payload = await response.json();
      if (payload?.error) return normalizePasswordValidationMessage(payload.error as string);
      if (payload?.message) return normalizePasswordValidationMessage(payload.message as string);
      if (payload?.code && typeof payload.code === 'string') return normalizePasswordValidationMessage(payload.code as string);
    } catch {
      if (responseClone && typeof responseClone.text === 'function') {
        try {
          const text = await responseClone.text();
          if (text?.trim()) return normalizePasswordValidationMessage(text.trim());
        } catch {
          // ignore parser errors and fall back to the original message
        }
      }
    }
  }

  return normalizePasswordValidationMessage(error?.message, 'Erro inesperado');
}
