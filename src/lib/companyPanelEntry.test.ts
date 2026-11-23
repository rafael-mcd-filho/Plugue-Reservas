import { describe, expect, it } from 'vitest';
import { getCompanyPanelEntryPath } from './companyPanelEntry';
describe('company entry after restricting table configuration', () => {
  it('never sends an operator to table configuration even with an existing tables grant', () => {
    expect(getCompanyPanelEntryPath('unit', permission => permission === 'tables_view', ['operator'])).toBeNull();
    expect(getCompanyPanelEntryPath('unit', permission => ['tables_view', 'waitlist_view'].includes(permission), ['operator'])).toBe('/unit/admin/servico?tab=fila');
  });
  it('keeps table configuration available to administrators', () => {
    expect(getCompanyPanelEntryPath('unit', permission => permission === 'tables_view', ['admin'])).toBe('/unit/admin/mesas');
    expect(getCompanyPanelEntryPath('unit', permission => permission === 'tables_view', ['superadmin'])).toBe('/unit/admin/mesas');
  });
});
