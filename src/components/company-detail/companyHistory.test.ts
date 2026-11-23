import { describe, expect, it } from 'vitest';
import type { AuditLog } from '@/hooks/useSettings';
import type { ManagedUser } from '@/hooks/useUsers';
import { buildCompanyHistory } from './companyHistory';

const users = [
  { id: 'u1', full_name: 'Marina Alves', email: 'marina@exemplo.com' },
  { id: 'u2', full_name: 'Ana Suporte', email: 'ana@exemplo.com' },
] as ManagedUser[];

describe('buildCompanyHistory', () => {
  it('merges panel access and audit actions in a single newest-first timeline', () => {
    const items = buildCompanyHistory(
      [
        { id: 'a1', user_id: 'u1', event_type: 'panel_access', path: '/x/admin', created_at: '2026-11-22T19:12:00Z', metadata: {} },
        { id: 'a2', user_id: 'u2', event_type: 'panel_access', path: '/x/admin', created_at: '2026-11-22T20:00:00Z', metadata: { impersonated_by_support: true } },
      ],
      [
        {
          id: 'l1', user_id: 'admin', actor_user_id: 'admin', action: 'set_company_billing_enabled', entity_type: 'company_billing',
          entity_id: 'company-1', details: { success: true, billing_enabled: true }, ip_address: null,
          created_at: '2026-11-18T12:37:00Z', actor_name: 'Rafael Macedo', actor_email: null,
        } as AuditLog,
      ],
      users,
      () => 'Beco Mágico - Goiânia',
    );
    expect(items.map((item) => item.text)).toEqual([
      'Ana Suporte acessou o painel como suporte',
      'Marina Alves acessou o painel',
      'Rafael Macedo: ativou a cobrança da assinatura de Beco Mágico - Goiânia',
    ]);
    expect(items[0].tag).toBe('Acesso de suporte');
    expect(items[2]).toMatchObject({ kind: 'alteracao', tag: 'Financeiro' });
  });

  it('groups consecutive panel accesses of the same person into one session', () => {
    const access = ['22:06', '22:04', '22:02', '21:54'].map((time, index) => ({
      id: `a${index}`, user_id: 'u1', event_type: 'panel_access', path: '/x/admin',
      created_at: `2026-11-22T${time}:00`, metadata: {},
    }));
    const items = buildCompanyHistory([...access, {
      id: 'old', user_id: 'u1', event_type: 'panel_access', path: '/x/admin', created_at: '2026-11-22T18:00:00', metadata: {},
    }], [], users, () => null);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe('Marina Alves acessou o painel · 4 vezes entre 21:54 e 22:06');
    expect(items[1].text).toBe('Marina Alves acessou o painel');
  });

  it('keeps one session per person even when another person used the panel in between', () => {
    const at = (id: string, user: string, time: string) => ({
      id, user_id: user, event_type: 'panel_access', path: '/x/admin', created_at: `2026-11-22T${time}:00`, metadata: {},
    });
    const items = buildCompanyHistory(
      [at('1', 'u1', '22:06'), at('2', 'u2', '22:05'), at('3', 'u1', '22:04'), at('4', 'u2', '22:05')],
      [],
      users,
      () => null,
    );
    expect(items.map((item) => item.text)).toEqual([
      'Marina Alves acessou o painel · 2 vezes entre 22:04 e 22:06',
      'Ana Suporte acessou o painel · 2 vezes às 22:05',
    ]);
  });
});
