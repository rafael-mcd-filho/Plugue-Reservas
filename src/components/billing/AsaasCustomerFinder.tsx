import { useState, type KeyboardEvent } from 'react';
import { ArrowRight, Check, Loader2, Search, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSearchAsaasCustomers } from '@/hooks/usePlatformBilling';
import type { ValidatedAsaasCustomer } from '@/lib/platform-billing-contracts';

interface AsaasCustomerFinderProps {
  companyId?: string | null;
  selectedCustomerId?: string | null;
  disabled?: boolean;
  onSelect: (customer: ValidatedAsaasCustomer) => void;
}

export default function AsaasCustomerFinder({
  companyId,
  selectedCustomerId,
  disabled = false,
  onSelect,
}: AsaasCustomerFinderProps) {
  const [query, setQuery] = useState('');
  const searchCustomers = useSearchAsaasCustomers();
  const customers = searchCustomers.data?.customers ?? [];

  const handleSearch = async () => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) {
      toast.warning('Digite pelo menos 2 caracteres para pesquisar no Asaas.');
      return;
    }

    try {
      await searchCustomers.mutateAsync({ query: normalizedQuery, limit: 20 });
    } catch (error: any) {
      toast.error(error?.message || 'Não foi possível pesquisar os clientes no Asaas.');
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void handleSearch();
  };

  return (
    <section className="max-w-2xl overflow-hidden rounded-xl border border-primary/15 bg-gradient-to-br from-primary/[0.055] via-background to-background">
      <div className="border-b border-primary/10 px-4 py-3.5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
            <Search className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Localizar cliente no Asaas</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Busque por nome, CPF/CNPJ, e-mail ou pelo próprio Customer ID.
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (searchCustomers.isSuccess || searchCustomers.isError) searchCustomers.reset();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Ex.: Beco Mágico, CNPJ ou e-mail"
            autoComplete="off"
            disabled={disabled || searchCustomers.isPending}
            aria-label="Pesquisar cliente no Asaas"
            className="bg-background/85"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleSearch()}
            disabled={disabled || searchCustomers.isPending || query.trim().length < 2}
            className="shrink-0 gap-2 bg-background"
          >
            {searchCustomers.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Search className="h-4 w-4" />}
            Buscar no Asaas
          </Button>
        </div>
      </div>

      {searchCustomers.isSuccess && (
        <div className="px-3 py-3" aria-live="polite">
          {customers.length === 0 ? (
            <div className="px-3 py-5 text-center">
              <p className="text-sm font-medium">Nenhum cliente encontrado</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Confira a grafia ou tente pesquisar apenas parte do nome ou documento.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {searchCustomers.data.pagination.totalCount} resultado{searchCustomers.data.pagination.totalCount === 1 ? '' : 's'}
                </p>
                {searchCustomers.data.pagination.hasMore && (
                  <p className="text-[11px] text-muted-foreground">Exibindo os 20 primeiros</p>
                )}
              </div>
              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {customers.map((customer) => {
                  const selected = customer.id === selectedCustomerId;
                  const linkedElsewhere = !!customer.linkedCompanyId && customer.linkedCompanyId !== companyId;
                  const detail = [customer.cpfCnpj, customer.email].filter(Boolean).join(' · ');

                  return (
                    <button
                      key={customer.id}
                      type="button"
                      onClick={() => onSelect(customer)}
                      disabled={disabled || linkedElsewhere}
                      className={`group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        linkedElsewhere
                          ? 'cursor-not-allowed border-border/50 bg-muted/15 opacity-60'
                          : selected
                          ? 'border-primary/35 bg-primary/[0.08]'
                          : 'border-transparent bg-muted/25 hover:border-border hover:bg-muted/50'
                      }`}
                    >
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground shadow-sm'}`}>
                        {selected ? <Check className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-foreground">{customer.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {detail || 'Sem documento ou e-mail cadastrado'}
                        </span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground sm:hidden">
                          {customer.id}
                        </span>
                        {linkedElsewhere && (
                          <span className="mt-1 block text-[10px] font-semibold text-amber-800 sm:hidden">Já vinculado a outra empresa</span>
                        )}
                      </span>
                      <span className="hidden shrink-0 text-right sm:block">
                        <Badge variant="outline" className="max-w-44 truncate bg-background font-mono text-[10px] font-normal text-muted-foreground">
                          {customer.id}
                        </Badge>
                        <span className={`mt-1 flex items-center justify-end gap-1 text-[10px] font-medium ${linkedElsewhere ? 'text-amber-800' : 'text-primary opacity-0 transition-opacity group-hover:opacity-100'}`}>
                          {!linkedElsewhere && <ArrowRight className="h-2.5 w-2.5" />}
                          {linkedElsewhere ? 'Vinculado a outra empresa' : 'Selecionar'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {searchCustomers.isError && (
        <div className="border-t border-destructive/15 bg-destructive-soft/35 px-4 py-3" role="alert">
          <p className="text-sm font-semibold text-destructive">A pesquisa no Asaas falhou</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Nenhum vínculo foi alterado. Confira o token global e tente novamente.
          </p>
        </div>
      )}
    </section>
  );
}
