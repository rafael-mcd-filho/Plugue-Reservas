import { useId, useState } from 'react';
import { AlertTriangle, Building2, Loader2, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

interface AccessCompany {
  id: string;
  name: string;
}

interface SupportCompanyAccessProps {
  companies: AccessCompany[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  unavailable?: boolean;
  disabled?: boolean;
  onRetry: () => void;
}

function normalizeSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export default function SupportCompanyAccess({
  companies,
  selectedIds,
  onChange,
  isLoading,
  isFetching,
  error,
  unavailable,
  disabled,
  onRetry,
}: SupportCompanyAccessProps) {
  const searchId = useId();
  const [search, setSearch] = useState('');
  const selected = new Set(selectedIds);
  const knownIds = new Set(companies.map((company) => company.id));
  const options = [
    ...companies,
    ...selectedIds.filter((id) => !knownIds.has(id)).map((id) => ({
      id,
      name: `Empresa indisponível (${id.slice(0, 8)})`,
    })),
  ].filter((company) => normalizeSearch(company.name).includes(normalizeSearch(search.trim())));

  return (
    <fieldset className="space-y-3 rounded-lg border bg-muted/20 p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Empresas autorizadas</legend>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          O Suporte poderá visualizar e impersonar usuários somente das empresas selecionadas.
        </p>
        {!unavailable && (
          <Badge variant="secondary" className="shrink-0 text-xs" aria-live="polite">
            {selected.size} {selected.size === 1 ? 'selecionada' : 'selecionadas'}
          </Badge>
        )}
      </div>
      {isLoading ? (
        <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando empresas...
        </p>
      ) : error || unavailable ? (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/20 bg-destructive/5 p-3">
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {unavailable
              ? 'Não foi possível carregar as autorizações deste usuário. Recarregue antes de salvar.'
              : 'Não foi possível carregar as empresas. Recarregue antes de selecionar os acessos.'}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={isFetching}>
            {isFetching ? 'Carregando...' : 'Tentar novamente'}
          </Button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              id={searchId}
              name="search_support_companies"
              aria-label="Buscar empresas autorizadas"
              placeholder="Buscar empresa..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-10 bg-background pl-9"
              autoComplete="off"
            />
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-background p-1">
            {options.length === 0 ? (
              <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                {search ? 'Nenhuma empresa encontrada.' : 'Nenhuma empresa cadastrada.'}
              </p>
            ) : options.map((company) => (
              <label
                key={company.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 hover:bg-muted/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <Checkbox
                  checked={selected.has(company.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) => onChange(checked === true
                    ? [...selectedIds, company.id]
                    : selectedIds.filter((id) => id !== company.id))}
                  aria-label={company.name}
                />
                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 break-words text-sm">{company.name}</span>
              </label>
            ))}
          </div>
          {selected.size === 0 && (
            <p className="text-xs text-muted-foreground">Sem seleção, este usuário não terá acesso a nenhuma empresa.</p>
          )}
        </>
      )}
    </fieldset>
  );
}
