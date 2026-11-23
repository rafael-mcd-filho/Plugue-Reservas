import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { AuditLog } from '@/hooks/useSettings';
import { actionsForCategory, AUDIT_ACTIONS, type AuditCategory } from '@/lib/audit-log-catalog';

export interface AuditLogFilters {
  page: number;
  pageSize: number;
  /** Dias para trás; null = todo o histórico. */
  days: number | null;
  category: AuditCategory | 'outros' | null;
  companyId: string | null;
  actorId: string | null;
  search: string;
}

const KNOWN_ACTIONS = Object.keys(AUDIT_ACTIONS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeText(value: string) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
}

/** Remove caracteres que mudariam o filtro do PostgREST. */
function sanitizeSearch(value: string) {
  return value.replace(/[%,()*:"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export async function fetchAuditLogPage(filters: AuditLogFilters) {
  const from = (filters.page - 1) * filters.pageSize;
  let query = supabase
    .from('audit_logs' as any)
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  if (filters.days) {
    query = query.gte('created_at', new Date(Date.now() - filters.days * 24 * 60 * 60 * 1000).toISOString());
  }
  if (filters.category === 'outros') {
    query = query.not('action', 'in', `(${KNOWN_ACTIONS.join(',')})`);
  } else if (filters.category) {
    query = query.in('action', actionsForCategory(filters.category));
  }
  if (filters.actorId && UUID.test(filters.actorId)) {
    query = query.eq('actor_user_id', filters.actorId);
  }
  if (filters.companyId && UUID.test(filters.companyId)) {
    query = query.or(`entity_id.eq.${filters.companyId},details->>company_id.eq.${filters.companyId}`);
  }
  const search = sanitizeSearch(filters.search);
  if (search) {
    // Também procura nas frases em português do catálogo (ex.: "cadastro" → update_company).
    const term = normalizeText(search);
    const matchedActions = Object.entries(AUDIT_ACTIONS)
      .filter(([, entry]) => normalizeText(entry.label).includes(term))
      .map(([action]) => action);
    const conditions = [
      `actor_name.ilike.*${search}*`,
      `actor_email.ilike.*${search}*`,
      `action.ilike.*${search.replace(/\s/g, '_')}*`,
      ...(matchedActions.length ? [`action.in.(${matchedActions.join(',')})`] : []),
    ];
    query = query.or(conditions.join(','));
  }

  const { data, error, count } = await query.range(from, from + filters.pageSize - 1);
  if (error) throw error;

  const rows = (data ?? []) as any[];
  const userIds = [...new Set(rows
    .filter((row) => row.actor_name == null || row.actor_email == null)
    .map((row) => row.user_id)
    .filter(Boolean))];
  const profileMap = new Map<string, { actor_name: string | null; actor_email: string | null }>();
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles' as any)
      .select('id, full_name, email')
      .in('id', userIds as any);
    if (profilesError) throw profilesError;
    for (const profile of (profiles ?? []) as any[]) {
      profileMap.set(profile.id, { actor_name: profile.full_name || null, actor_email: profile.email || null });
    }
  }

  const logs = rows.map((row) => {
    const actor = profileMap.get(row.user_id);
    return {
      ...row,
      actor_user_id: row.actor_user_id ?? row.user_id ?? null,
      actor_name: row.actor_name ?? actor?.actor_name ?? null,
      actor_email: row.actor_email ?? actor?.actor_email ?? null,
    };
  }) as AuditLog[];

  return { logs, total: count ?? logs.length };
}

/** Página do histórico de ações, com filtros e paginação feitos no banco. */
export function useAuditLogPage(filters: AuditLogFilters) {
  return useQuery({
    queryKey: ['audit-logs', 'page', filters],
    queryFn: () => fetchAuditLogPage(filters),
    placeholderData: keepPreviousData,
    retry: false,
  });
}
