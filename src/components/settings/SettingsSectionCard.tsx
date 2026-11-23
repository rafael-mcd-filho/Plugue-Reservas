import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

interface SettingsSectionCardProps {
  title: string;
  description?: ReactNode;
  status?: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
  extraActions?: ReactNode;
  children: ReactNode;
}

/**
 * Seção de configuração com salvar e descartar próprios. Cada seção salva só
 * os próprios campos, para uma falha não deixar parte de outra seção salva.
 */
export default function SettingsSectionCard({
  title,
  description,
  status,
  dirty,
  saving,
  onSave,
  onDiscard,
  saveLabel = 'Salvar',
  saveDisabled,
  extraActions,
  children,
}: SettingsSectionCardProps) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            {description && <CardDescription className="mt-1 max-w-2xl">{description}</CardDescription>}
          </div>
          <div className="flex flex-wrap gap-2">
            {dirty && (
              <Badge variant="outline" className="w-fit border-warning/30 bg-warning-soft text-amber-900">
                Alterações não salvas
              </Badge>
            )}
            {status}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {children}
        {(onSave || extraActions) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {onSave && (
              <Button type="button" onClick={onSave} disabled={saveDisabled || saving || !dirty} className="gap-2">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saveLabel}
              </Button>
            )}
            {onDiscard && dirty && (
              <Button type="button" variant="outline" onClick={onDiscard} disabled={saving}>
                Descartar
              </Button>
            )}
            {extraActions}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
