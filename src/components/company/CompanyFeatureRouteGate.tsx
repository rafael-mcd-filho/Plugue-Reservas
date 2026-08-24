import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import type { CompanyFeatureKey } from '@/lib/companyFeatures';

interface CompanyFeatureRouteGateProps {
  requiredCompanyFeature?: CompanyFeatureKey;
  loadingFallback: ReactNode;
  children: ReactNode;
}

export default function CompanyFeatureRouteGate({
  requiredCompanyFeature,
  loadingFallback,
  children,
}: CompanyFeatureRouteGateProps) {
  const { companyId } = useCompanySlug();
  const featureQuery = useCompanyFeatureFlags(
    requiredCompanyFeature ? companyId : undefined,
  );

  if (!requiredCompanyFeature) return <>{children}</>;

  if (
    featureQuery.isLoading
    || (!featureQuery.data && featureQuery.isFetching && !featureQuery.isError)
  ) {
    return <>{loadingFallback}</>;
  }

  // A failed or empty feature lookup must never mount the protected route.
  // Keep this distinct from AccessDenied so a transient network problem does
  // not turn into an authorization redirect loop while impersonating.
  if (featureQuery.isError || !featureQuery.data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
        <Alert role="alert" variant="destructive" className="w-full max-w-lg">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Não foi possível validar o acesso</AlertTitle>
          <AlertDescription className="space-y-4">
            <p>
              Não conseguimos confirmar os recursos liberados para esta unidade.
              Tente novamente antes de abrir esta página.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void featureQuery.refetch()}
              disabled={featureQuery.isFetching}
            >
              <RefreshCw
                className={featureQuery.isFetching ? 'h-4 w-4 animate-spin motion-reduce:animate-none' : 'h-4 w-4'}
                aria-hidden="true"
              />
              {featureQuery.isFetching ? 'Validando…' : 'Tentar novamente'}
            </Button>
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  if (featureQuery.data.features[requiredCompanyFeature] === false) {
    return <Navigate to="/acesso-negado" replace />;
  }

  return <>{children}</>;
}
