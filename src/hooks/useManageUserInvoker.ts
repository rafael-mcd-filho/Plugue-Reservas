import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import { useImpersonation } from '@/hooks/useImpersonation';

export function useManageUserInvoker() {
  const { isImpersonatingCompany, effectiveRole, scopeCompanyId } = useImpersonation();

  const invokeManageUser = async <T = any>(body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('manage-user', {
      body: {
        ...body,
        ...(isImpersonatingCompany
          ? {
              scope_company_id: scopeCompanyId,
              impersonated_by_superadmin: true,
              effective_role: effectiveRole,
            }
          : {}),
      },
    });

    if (error) {
      throw new Error(await getFunctionErrorMessage(error));
    }

    if (data?.error) {
      throw new Error(data.error as string);
    }

    return data as T;
  };

  return {
    invokeManageUser,
    manageUserScopeKey: isImpersonatingCompany ? `${scopeCompanyId ?? 'company'}:${effectiveRole ?? 'unknown'}` : 'global',
  };
}
