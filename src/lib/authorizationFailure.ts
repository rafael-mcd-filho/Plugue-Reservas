export function isAuthorizationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return ['42501', '28000', '28P01', 'PGRST301', 'PGRST302', '401', '403'].includes(String(code ?? ''))
    || status === 401 || status === 403;
}
