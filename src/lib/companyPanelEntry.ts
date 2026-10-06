import type { CompanyPanelPermission } from '@/lib/companyPermissions';

const ENTRY_ROUTES: ReadonlyArray<readonly [CompanyPanelPermission, string]> = [
  ['dashboard_view', ''],
  ['checkins_view', '/check-ins'],
  ['reservations_view', '/reservas'],
  ['calendar_view', '/reservas/calendario'],
  ['tables_view', '/mesas'],
  ['waitlist_view', '/fila'],
];

export function getCompanyPanelEntryPath(
  slug: string,
  hasPermission: (permission: CompanyPanelPermission) => boolean,
): string | null {
  const route = ENTRY_ROUTES.find(([permission]) => hasPermission(permission));
  return route ? `/${slug}/admin${route[1]}` : null;
}
