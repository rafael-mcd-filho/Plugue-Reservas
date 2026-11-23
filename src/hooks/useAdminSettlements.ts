import { useQuery } from '@tanstack/react-query';
import {
  getAdminSettlementOverview,
  type AdminSettlementOverview,
  type Withdrawal,
} from '@/lib/reservation-settlements-api';

/** Mesma raiz usada pela tela de repasses: invalidar a fila atualiza estes dados. */
export const ADMIN_SETTLEMENTS_KEY = 'admin-reservation-settlements';

/** O servidor aceita até 100 registros por consulta. */
const MAX_LIMIT = 100;

/** Pedidos que aguardam a plataforma: solicitados e em análise. */
export const PENDING_WITHDRAWAL_STATUSES = ['requested', 'under_review'] as const;

export async function fetchPendingWithdrawals() {
  const results = await Promise.all(
    PENDING_WITHDRAWAL_STATUSES.map((status) =>
      getAdminSettlementOverview(status, 0, 0, { limit: MAX_LIMIT, companyLimit: 1 })),
  );
  const seen = new Set<string>();
  const withdrawals: Withdrawal[] = [];
  for (const result of results) {
    for (const withdrawal of result.withdrawals) {
      if (seen.has(withdrawal.id)) continue;
      seen.add(withdrawal.id);
      withdrawals.push(withdrawal);
    }
  }
  withdrawals.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const total = results.reduce((sum, result) => sum + result.total, 0);
  return { withdrawals, total, complete: withdrawals.length >= total };
}

/** Quantidade de saques aguardando análise, para o contador do menu. */
export function usePendingWithdrawalCount({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: [ADMIN_SETTLEMENTS_KEY, 'pending-count'],
    queryFn: async () => {
      const results = await Promise.all(
        PENDING_WITHDRAWAL_STATUSES.map((status) =>
          getAdminSettlementOverview(status, 0, 0, { limit: 1, companyLimit: 1 })),
      );
      return results.reduce((sum, result) => sum + result.total, 0);
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Posição de todas as empresas. O servidor devolve até 100 empresas por
 * consulta; as páginas são lidas em sequência para somar o total real.
 */
export async function fetchAllSettlementCompanies() {
  const companies: AdminSettlementOverview['companies'] = [];
  let companyOffset = 0;
  let companyCount = 0;
  do {
    const page = await getAdminSettlementOverview('all', 0, companyOffset, { limit: 1, companyLimit: MAX_LIMIT });
    companies.push(...page.companies);
    companyCount = page.company_count;
    companyOffset += MAX_LIMIT;
    if (page.companies.length === 0) break;
  } while (companyOffset < companyCount);
  return companies;
}
