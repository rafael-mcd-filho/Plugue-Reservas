const PRIVATE_ROOT_SEGMENTS = new Set([
  'login',
  'redefinir-senha',
  'cadastro',
  'acesso-negado',
  'dashboard',
  'empresas',
  'usuarios',
  'configuracoes',
  'notificacoes',
  'logs',
  'integracoes',
  'financeiro',
  'perfil',
  'saude',
]);

function getPathSegments(pathname: string) {
  return pathname.split('?')[0].split('#')[0].split('/').filter(Boolean);
}

/** Selects the lightweight public application before the admin shell is loaded. */
export function isPublicApplicationPath(pathname: string) {
  const segments = getPathSegments(pathname);
  const [first, second] = segments;

  if (!first) return false;
  if (first === 'pagamento') return segments.length === 2;
  if (PRIVATE_ROOT_SEGMENTS.has(first) || second === 'admin') return false;

  if (segments.length === 1) return true;
  if (segments.length === 2 && second === 'fila') return true;
  if (segments.length !== 3) return false;

  return second === 'f'
    || second === 'fila'
    || second === 'reserva'
    || second === 'avaliacao';
}

/** Returns a slug only for routes that actually render CompanyPublicPage. */
export function getPublicCompanySlugFromPathname(pathname: string) {
  const segments = getPathSegments(pathname);
  const [first, second] = segments;

  if (!first || PRIVATE_ROOT_SEGMENTS.has(first)) return null;
  if (segments.length === 1) return first;
  if (segments.length === 3 && second === 'f') return first;
  return null;
}
