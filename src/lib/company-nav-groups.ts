// Qual grupo da barra lateral cobre a rota atual. Empresa e Configurações
// dividem as seções de /admin/configuracoes, então não dá para abrir um grupo
// olhando só o prefixo da URL: cada grupo conhece as suas rotas.

export type CompanyNavGroup =
  | 'reports'
  | 'reservations'
  | 'profile'
  | 'settings'
  | 'business'
  | 'automation';

const COMPANY_NAV_GROUP_PATHS: Record<CompanyNavGroup, string[]> = {
  reports: ['/admin/relatorios'],
  reservations: ['/admin/reservas'],
  profile: [
    '/admin/configuracoes/empresa',
    '/admin/configuracoes/agenda',
    '/admin/configuracoes/reservas',
  ],
  settings: [
    '/admin/configuracoes/disponibilidade',
    '/admin/configuracoes/pagina-publica',
    '/admin/mesas',
  ],
  business: [
    '/admin/pagamentos-antecipados',
    '/admin/avaliacoes',
    '/admin/usuarios',
    '/admin/leads',
  ],
  automation: ['/admin/automacoes', '/admin/eventos'],
};

export function isCompanyNavGroupActive(pathname: string, group: CompanyNavGroup) {
  return COMPANY_NAV_GROUP_PATHS[group].some((path) => (
    pathname.endsWith(path) || pathname.includes(`${path}/`)
  ));
}
