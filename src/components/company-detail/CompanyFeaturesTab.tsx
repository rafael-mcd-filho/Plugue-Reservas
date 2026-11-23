import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import ListStateMessage from '@/components/admin/ListStateMessage';
import CompanyFeatureSwitchList from '@/components/company/CompanyFeatureSwitchList';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCompanyFeatureFlags, useSaveCompanyFeatures, type CompanyFeatureState } from '@/hooks/useCompanyFeatures';
import { COMPANY_FEATURE_DEFINITIONS } from '@/lib/companyFeatures';
import { cn } from '@/lib/utils';

export default function CompanyFeaturesTab({
  companyId,
  onDirtyChange,
}: {
  companyId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const flagsQuery = useCompanyFeatureFlags(companyId);
  const saveFeatures = useSaveCompanyFeatures();
  const saved = flagsQuery.data?.features ?? null;
  const [draft, setDraft] = useState<CompanyFeatureState | null>(saved);
  const changed = saved && draft
    ? COMPANY_FEATURE_DEFINITIONS.filter((feature) => !!draft[feature.key] !== !!saved[feature.key])
    : [];
  const dirty = changed.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirtyRef.current) setDraft(saved);
  }, [saved]);

  if (flagsQuery.isPending) {
    return <Card className="shadow-sm"><CardContent className="space-y-3 p-6">{[1, 2, 3].map((item) => <Skeleton key={item} className="h-14 w-full" />)}</CardContent></Card>;
  }
  if (flagsQuery.isError || !saved || !draft) {
    return (
      <Card className="shadow-sm">
        <ListStateMessage
          variant="error"
          title="Não foi possível carregar os recursos"
          description="Os controles ficaram ocultos para não salvar valores errados."
          actionLabel="Tentar novamente"
          onAction={() => void flagsQuery.refetch()}
        />
      </Card>
    );
  }

  const activeCount = COMPANY_FEATURE_DEFINITIONS.filter((feature) => draft[feature.key]).length;

  return (
    <Card className="shadow-sm">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">Recursos da empresa</CardTitle>
          <CardDescription>O que a empresa pode usar no painel e na página de reservas.</CardDescription>
        </div>
        <span className="text-sm text-muted-foreground">{activeCount} de {COMPANY_FEATURE_DEFINITIONS.length} ativos</span>
      </CardHeader>
      <CardContent className="space-y-4">
        <CompanyFeatureSwitchList
          features={draft}
          disabled={saveFeatures.isPending}
          onToggle={(key, enabled) => setDraft((current) => (current ? { ...current, [key]: enabled } : current))}
        />
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <span className={cn('mr-auto text-xs', dirty ? 'font-semibold text-amber-900' : 'text-muted-foreground')}>
            {dirty
              ? `${changed.length === 1 ? '1 alteração não salva' : `${changed.length} alterações não salvas`}: ${changed.map((feature) => feature.label).join(', ')}`
              : 'Nenhuma alteração'}
          </span>
          <Button type="button" variant="outline" disabled={!dirty || saveFeatures.isPending} onClick={() => setDraft(saved)}>
            Descartar
          </Button>
          <Button
            type="button"
            disabled={!dirty || saveFeatures.isPending}
            className="gap-2"
            onClick={() => saveFeatures.mutate({ companyId, features: draft })}
          >
            {saveFeatures.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar recursos
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
