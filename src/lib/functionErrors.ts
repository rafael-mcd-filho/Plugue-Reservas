export async function getFunctionErrorMessage(error: any) {
  if (error?.context) {
    const response = error.context;
    const responseClone = typeof response.clone === 'function' ? response.clone() : null;

    try {
      const payload = await response.json();
      if (payload?.error) return payload.error as string;
      if (payload?.message) return payload.message as string;
      if (payload?.code && typeof payload.code === 'string') return payload.code as string;
    } catch {
      if (responseClone && typeof responseClone.text === 'function') {
        try {
          const text = await responseClone.text();
          if (text?.trim()) return text.trim();
        } catch {
          // ignore parser errors and fall back to the original message
        }
      }
    }
  }

  return error?.message || 'Erro inesperado';
}
