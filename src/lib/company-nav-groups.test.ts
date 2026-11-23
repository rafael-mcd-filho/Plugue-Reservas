import { isCompanyNavGroupActive } from './company-nav-groups';

const BASE = '/beco-magico/admin';

describe('company-nav-groups', () => {
  it('abre Empresa para cadastro, equipe e rastreamento nas URLs existentes', () => {
    ['configuracoes/empresa', 'usuarios', 'eventos'].forEach((path) => {
      const pathname = `${BASE}/${path}`;
      expect(isCompanyNavGroupActive(pathname, 'company')).toBe(true);
      expect(isCompanyNavGroupActive(pathname, 'operations')).toBe(false);
      expect(isCompanyNavGroupActive(pathname, 'communication')).toBe(false);
    });
  });

  it('abre Operação nas configurações da reserva e no mapa de mesas', () => {
    ['agenda', 'reservas', 'disponibilidade', 'pagina-publica'].forEach((section) => {
      const pathname = `${BASE}/configuracoes/${section}`;
      expect(isCompanyNavGroupActive(pathname, 'operations')).toBe(true);
      expect(isCompanyNavGroupActive(pathname, 'company')).toBe(false);
    });

    expect(isCompanyNavGroupActive(`${BASE}/mesas`, 'operations')).toBe(true);
  });

  it('não confunde a operação de reservas com as regras de reservas', () => {
    expect(isCompanyNavGroupActive(`${BASE}/reservas`, 'reservations')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/reservas/calendario`, 'reservations')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/configuracoes/reservas`, 'reservations')).toBe(false);
    expect(isCompanyNavGroupActive(`${BASE}/reservas`, 'operations')).toBe(false);
  });

  it('agrupa mensagens e avaliações em Comunicação', () => {
    expect(isCompanyNavGroupActive(`${BASE}/automacoes`, 'communication')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/avaliacoes`, 'communication')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/eventos`, 'communication')).toBe(false);
  });

  it('não associa os acessos diretos a grupos recolhíveis', () => {
    ['leads', 'pagamentos-antecipados', 'filiados', 'financeiro'].forEach((path) => {
      ['company', 'operations', 'communication'].forEach((group) => {
        expect(isCompanyNavGroupActive(`${BASE}/${path}`, group as 'company' | 'operations' | 'communication')).toBe(false);
      });
    });
  });

  it('mantém os relatórios em seu próprio grupo', () => {
    expect(isCompanyNavGroupActive(`${BASE}/relatorios/recorrencia`, 'reports')).toBe(true);
    expect(isCompanyNavGroupActive(`${BASE}/relatorios/recorrencia`, 'operations')).toBe(false);
  });
});
