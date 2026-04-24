import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import { useImpersonation } from '@/hooks/useImpersonation';
import { normalizePasswordValidationMessage } from '@/lib/validation';

const MANAGE_USER_TIMEOUT_MS = 15000;

async function getManageUserAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Sessao expirada ou indisponivel. Entre novamente.');
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
  };
}

export async function invokeManageUserRequest(body: Record<string, unknown>) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const headers = await getManageUserAuthHeaders();

    return await Promise.race([
      supabase.functions.invoke('manage-user', { body, headers }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('A funcao de usuarios demorou mais que o esperado para responder. Tente novamente.'));
        }, MANAGE_USER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function useManageUserInvoker() {
  const { isImpersonatingCompany, effectiveRole, scopeCompanyId } = useImpersonation();

  const invokeManageUser = async <T = any>(body: Record<string, unknown>) => {
    const requestBody = {
      ...body,
      ...(isImpersonatingCompany
        ? {
            scope_company_id: scopeCompanyId,
            impersonated_by_superadmin: true,
            effective_role: effectiveRole,
          }
        : {}),
    };

    const { data, error } = await invokeManageUserRequest(requestBody);

    if (error) {
      throw new Error(await getFunctionErrorMessage(error));
    }

    if (data?.error) {
      throw new Error(normalizePasswordValidationMessage(data.error as string));
    }

    return data as T;
  };

  return {
    invokeManageUser,
    manageUserScopeKey: isImpersonatingCompany ? `${scopeCompanyId ?? 'company'}:${effectiveRole ?? 'unknown'}` : 'global',
  };
}
