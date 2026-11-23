import type { AppRole, CompanyPanelPermission } from '@/lib/companyPermissions';

const ENTRY_ROUTES: ReadonlyArray<readonly [CompanyPanelPermission, string]> = [
  ['dashboard_view', ''],
  ['checkins_view', '/check-ins'],
  ['reservations_view', '/reservas'],
  ['calendar_view', '/reservas/calendario'],
  ['tables_view', '/mesas'],
  ['waitlist_view', '/servico?tab=fila'],
];

export function getCompanyPanelEntryPath(
  slug: string,
  hasPermission: (permission: CompanyPanelPermission) => boolean,
  roles: readonly AppRole[] = [],
): string | null {
  const canConfigureTables = roles.includes('admin') || roles.includes('superadmin');
  const route = ENTRY_ROUTES.find(([permission]) => hasPermission(permission) && (permission !== 'tables_view' || canConfigureTables));
  return route ? `/${slug}/admin${route[1]}` : null;
}
