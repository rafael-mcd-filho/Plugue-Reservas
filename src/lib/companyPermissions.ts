export const APP_ROLES = ['superadmin', 'admin', 'operator'] as const;

export type AppRole = typeof APP_ROLES[number];

export const COMPANY_PANEL_PERMISSIONS = [
  'dashboard_view',
  'checkins_view',
  'reservations_view',
  'reservations_delete',
  'calendar_view',
  'tables_view',
  'waitlist_view',
  'automations_view',
  'users_view',
  'leads_view',
  'affiliates_view',
  'events_view',
  'settings_view',
] as const;

export type CompanyPanelPermission = typeof COMPANY_PANEL_PERMISSIONS[number];

export type CompanyPanelPermissionOverrides = Partial<Record<CompanyPanelPermission, boolean>>;

export const OPERATOR_ASSIGNABLE_COMPANY_PANEL_PERMISSIONS = [
  'dashboard_view',
  'checkins_view',
  'reservations_view',
  'reservations_delete',
  'calendar_view',
  'tables_view',
  'waitlist_view',
] as const satisfies readonly CompanyPanelPermission[];

export const DEFAULT_OPERATOR_PANEL_PERMISSIONS = [
  'dashboard_view',
  'checkins_view',
  'reservations_view',
  'calendar_view',
  'waitlist_view',
] as const;

export const COMPANY_PANEL_PERMISSION_METADATA: Record<
  CompanyPanelPermission,
  {
    label: string;
    description: string;
    operatorAssignable: boolean;
  }
> = {
  dashboard_view: {
    label: 'Dashboard',
    description: 'Resumo operacional, métricas e indicadores da unidade.',
    operatorAssignable: true,
  },
  checkins_view: {
    label: 'Check-ins',
    description: 'Atendimento do dia, chegada de clientes e check-in.',
    operatorAssignable: true,
  },
  reservations_view: {
    label: 'Reservas',
    description: 'Lista de reservas, filtros, edição e mudança de status.',
    operatorAssignable: true,
  },
  reservations_delete: {
    label: 'Excluir reservas',
    description: 'Permite remover reservas em definitivo.',
    operatorAssignable: true,
  },
  calendar_view: {
    label: 'Calendário',
    description: 'Visualização da agenda e ocupação por dia.',
    operatorAssignable: true,
  },
  tables_view: {
    label: 'Mesas',
    description: 'Mapa de mesas, capacidade e ocupação.',
    operatorAssignable: true,
  },
  waitlist_view: {
    label: 'Lista de espera',
    description: 'Fila de espera, chamada e conversão em reserva.',
    operatorAssignable: true,
  },
  automations_view: {
    label: 'Automações',
    description: 'Configuração de lembretes, campanhas e fluxos.',
    operatorAssignable: false,
  },
  users_view: {
    label: 'Usuários',
    description: 'Gestão de acessos e equipe da unidade.',
    operatorAssignable: false,
  },
  leads_view: {
    label: 'Leads',
    description: 'CRM, histórico de contatos e conversões.',
    operatorAssignable: false,
  },
  affiliates_view: {
    label: 'Filiados',
    description: 'Links de afiliados, parceiros e acompanhamento.',
    operatorAssignable: false,
  },
  events_view: {
    label: 'Eventos',
    description: 'Rastreamento, integrações e fila Meta.',
    operatorAssignable: false,
  },
  settings_view: {
    label: 'Configurações',
    description: 'Configurações estruturais da unidade.',
    operatorAssignable: false,
  },
};

function isAppRole(role: string): role is AppRole {
  return (APP_ROLES as readonly string[]).includes(role);
}

function normalizeRoles(roles: ReadonlyArray<string>) {
  return Array.from(new Set(roles.filter(isAppRole)));
}

function applyPermissionOverrides(
  permissions: Set<CompanyPanelPermission>,
  overrides?: CompanyPanelPermissionOverrides | null,
) {
  if (!overrides) return permissions;

  const next = new Set(permissions);

  for (const permission of OPERATOR_ASSIGNABLE_COMPANY_PANEL_PERMISSIONS) {
    const override = overrides[permission];
    if (override === true) next.add(permission);
    if (override === false) next.delete(permission);
  }

  return next;
}

// Centralize role-to-permission mapping here so persisted operator overrides can
// be plugged in later without changing route or navigation code again.
export function resolveCompanyPanelPermissions(
  roles: ReadonlyArray<string>,
  overrides?: CompanyPanelPermissionOverrides | null,
) {
  const normalizedRoles = normalizeRoles(roles);

  if (normalizedRoles.includes('superadmin') || normalizedRoles.includes('admin')) {
    return new Set<CompanyPanelPermission>(COMPANY_PANEL_PERMISSIONS);
  }

  if (!normalizedRoles.includes('operator')) {
    return new Set<CompanyPanelPermission>();
  }

  return applyPermissionOverrides(new Set<CompanyPanelPermission>(DEFAULT_OPERATOR_PANEL_PERMISSIONS), overrides);
}

export function hasCompanyPanelPermission(
  roles: ReadonlyArray<string>,
  permission: CompanyPanelPermission,
  overrides?: CompanyPanelPermissionOverrides | null,
) {
  return resolveCompanyPanelPermissions(roles, overrides).has(permission);
}

export function getCompanyPanelPermissionSelection(
  roles: ReadonlyArray<string>,
  overrides?: CompanyPanelPermissionOverrides | null,
) {
  const resolvedPermissions = resolveCompanyPanelPermissions(roles, overrides);

  return COMPANY_PANEL_PERMISSIONS.reduce((acc, permission) => {
    acc[permission] = resolvedPermissions.has(permission);
    return acc;
  }, {} as Record<CompanyPanelPermission, boolean>);
}

export function getDefaultOperatorPermissionSelection() {
  return getCompanyPanelPermissionSelection(['operator']);
}

export function buildOperatorPermissionOverrides(
  selection: Partial<Record<CompanyPanelPermission, boolean>>,
): CompanyPanelPermissionOverrides | null {
  const defaultPermissions = resolveCompanyPanelPermissions(['operator']);
  const overrides: CompanyPanelPermissionOverrides = {};

  for (const permission of OPERATOR_ASSIGNABLE_COMPANY_PANEL_PERMISSIONS) {
    const nextValue = selection[permission] === true;
    const defaultValue = defaultPermissions.has(permission);

    if (nextValue !== defaultValue) {
      overrides[permission] = nextValue;
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : null;
}
