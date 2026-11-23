import { RotateCw, SkipForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useForceSkipCompanyDeletionTeardown, type CompanyDeletionRequest } from '@/hooks/useCompanies';
import { useRetryCompanyDeletion } from '@/hooks/useRetryCompanyDeletion';

interface CompanyDeletionRecoveryActionsProps {
  request: Pick<CompanyDeletionRequest, 'company_id' | 'status' | 'phase'>;
}

export function CompanyDeletionRecoveryActions({ request }: CompanyDeletionRecoveryActionsProps) {
  const retryDeletion = useRetryCompanyDeletion();
  const forceSkipTeardown = useForceSkipCompanyDeletionTeardown();

  if (request.status !== 'needs_attention') return null;

  const isPending = retryDeletion.isPending || forceSkipTeardown.isPending;

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button" size="sm" variant="outline" className="gap-1.5"
        disabled={isPending}
        onClick={() => retryDeletion.mutate(request.company_id)}
      >
        <RotateCw className="h-3.5 w-3.5" /> Retomar exclusão
      </Button>
      {request.phase === 'external_teardown' && (
        <Button
          type="button" size="sm" variant="outline" className="gap-1.5"
          disabled={isPending}
          onClick={() => forceSkipTeardown.mutate(request.company_id)}
        >
          <SkipForward className="h-3.5 w-3.5" /> Pular etapa externa
        </Button>
      )}
    </div>
  );
}
