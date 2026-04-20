import { normalizePasswordValidationMessage } from '@/lib/validation';
import { supabase } from '@/integrations/supabase/client';

async function signOutOnExpiredSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    await supabase.auth.signOut();
  }
}

export async function getFunctionErrorMessage(error: any) {
  if (error?.context) {
    const response = error.context;
    const isUnauthorized = response.status === 401;
    const responseClone = typeof response.clone === 'function' ? response.clone() : null;

    try {
      const payload = await response.json();
      if (isUnauthorized) signOutOnExpiredSession();
      if (payload?.error) return normalizePasswordValidationMessage(payload.error as string);
      if (payload?.message) return normalizePasswordValidationMessage(payload.message as string);
      if (payload?.code && typeof payload.code === 'string') return normalizePasswordValidationMessage(payload.code as string);
    } catch {
      if (isUnauthorized) signOutOnExpiredSession();
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
