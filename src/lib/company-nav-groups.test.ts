import { isCompanyNavGroupActive } from './company-nav-groups';

const BASE = '/beco-magico/admin';

describe('company-nav-groups', () => {
  it('abre Empresa, e não Configurações, nas seções da empresa', () => {
    ['empresa', 'agenda', 'reservas'].forEach((section) => {
      const pathname = `${BASE}/configuracoes/${section}`;
      expect(isCompanyNavGroupActive(pathname, 'profile')).toBe(true);
      expect(isCompanyNavGroupActive(pathname, 'settings')).toBe(false);
    });
  });

  it('abre Configurações nas seções de experiência e em mesas', () => {
    ['disponibilidade', 'pagina-publica'].forEach((section) => {
      const pathname = `${BASE}/configuracoes/${section}`;
      expect(isCompanyNavGroupActive(pathname, 'settings')).toBe(true);
      expect(isCompanyNavGroupActive(pathname, 'profile')).toBe(false);
    });

    expect(isCompanyNavGroupActive(`${BASE}/mesas`, 'settings')).toBe(true);
  });

  it('não confunde a operação de reservas com as regras de reservas', () => {
    expect(isCompanyNavGroupActive(`${BASE}/reservas`, 'reservations')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/reservas/calendario`, 'reservations')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/configuracoes/reservas`, 'reservations')).toBe(false);
    expect(isCompanyNavGroupActive(`${BASE}/reservas`, 'profile')).toBe(false);
  });

  it('cobre os grupos de gestão e automações', () => {
    expect(isCompanyNavGroupActive(`${BASE}/leads`, 'business')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/pagamentos-antecipados`, 'business')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/automacoes`, 'automation')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/eventos`, 'automation')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/eventos`, 'business')).toBe(false);
  });

  it('mantém os relatórios em seu próprio grupo', () => {
    expect(isCompanyNavGroupActive(`${BASE}/relatorios/recorrencia`, 'reports')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/relatorios/recorrencia`, 'settings')).toBe(false);
  });
});
