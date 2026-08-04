import { ArrowLeft, RefreshCw, ShieldAlert } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePlatformBillingModuleStatus, useSuperadminBillingOverview } from '@/hooks/usePlatformBilling';
import { CompanyBillingView } from '@/pages/CompanyBilling';

export default function AdminCompanyBillingPreview() {
  const { companyId } = useParams<{ companyId: string }>();
  const moduleQuery = usePlatformBillingModuleStatus();
  const overviewQuery = useSuperadminBillingOverview();
  const company = overviewQuery.data?.companies.find((item) => item.companyId === companyId);
  const isLoading = moduleQuery.isLoading || overviewQuery.isLoading;
  const hasError = moduleQuery.isError
    || overviewQuery.isError
    || moduleQuery.data?.available === false
    || overviewQuery.data?.available === false;

  if (!companyId) return <Navigate to="/financeiro" replace />;

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-24 rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-lg" />)}
        </div>
        <Skeleton className="h-80 rounded-lg" />
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="space-y-5">
        <Button asChild variant="ghost" className="-ml-3 gap-2">
          <Link to="/financeiro"><ArrowLeft className="h-4 w-4" />Voltar ao Financeiro</Link>
        </Button>
        <Card className="border-destructive/20 shadow-sm">
          <CardContent className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 rounded-xl bg-destructive-soft p-3 text-destructive">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <h1 className="font-semibold">Não foi possível abrir a prévia</h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              A estrutura financeira não respondeu. Nenhum dado foi tratado como zero e a visão das empresas não foi alterada.
            </p>
            <Button
              variant="outline"
              onClick={() => Promise.all([moduleQuery.refetch(), overviewQuery.refetch()])}
              className="mt-4 gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!company) return <Navigate to="/financeiro" replace />;

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" className="-ml-3 gap-2">
        <Link to="/financeiro">
          <ArrowLeft className="h-4 w-4" />
          Voltar ao Financeiro
        </Link>
      </Button>
      <CompanyBillingView
        companyId={company.companyId}
        companyName={company.companyName}
        allowWhenDisabled
      />
    </div>
  );
}
