// Os rótulos e agrupamentos do menu mudam sem alterar os endereços existentes.
// Cada grupo conhece suas rotas para abrir também por um link direto.

export type CompanyNavGroup =
  | 'reports'
  | 'reservations'
  | 'company'
  | 'operations'
  | 'communication';

const COMPANY_NAV_GROUP_PATHS: Record<CompanyNavGroup, string[]> = {
  reports: ['/admin/relatorios'],
  reservations: ['/admin/reservas'],
  company: [
    '/admin/configuracoes/empresa',
    '/admin/usuarios',
    '/admin/eventos',
  ],
  operations: [
    '/admin/configuracoes/agenda',
    '/admin/configuracoes/reservas',
    '/admin/configuracoes/disponibilidade',
    '/admin/configuracoes/pagina-publica',
    '/admin/mesas',
  ],
  communication: [
    '/admin/automacoes',
    '/admin/avaliacoes',
  ],
};

export function isCompanyNavGroupActive(pathname: string, group: CompanyNavGroup) {
  return COMPANY_NAV_GROUP_PATHS[group].some((path) => (
    pathname.endsWith(path) || pathname.includes(`${path}/`)
  ));
}
