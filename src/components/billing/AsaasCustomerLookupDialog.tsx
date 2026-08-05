import { useMemo, useState } from 'react';
import { Building2, Copy, Link2, Loader2, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import AsaasCustomerFinder from '@/components/billing/AsaasCustomerFinder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSaveCompanyBillingLink } from '@/hooks/usePlatformBilling';
import type {
  PlatformBillingCompanyOverview,
  ValidatedAsaasCustomer,
} from '@/lib/platform-billing-contracts';

interface AsaasCustomerLookupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: PlatformBillingCompanyOverview[];
}

export default function AsaasCustomerLookupDialog({
  open,
  onOpenChange,
  companies,
}: AsaasCustomerLookupDialogProps) {
  const [selectedCustomer, setSelectedCustomer] = useState<ValidatedAsaasCustomer | null>(null);
  const [targetCompanyId, setTargetCompanyId] = useState('');
  const saveLink = useSaveCompanyBillingLink();

  const unconfiguredCompanies = useMemo(
    () => companies
      .filter((company) => !company.configured)
      .sort((left, right) => left.companyName.localeCompare(right.companyName, 'pt-BR')),
    [companies],
  );
  const linkedCompany = selectedCustomer?.linkedCompanyId
    ? companies.find((company) => company.companyId === selectedCustomer.linkedCompanyId) ?? null
    : null;
  const targetCompany = targetCompanyId
    ? unconfiguredCompanies.find((company) => company.companyId === targetCompanyId) ?? null
    : null;

  const reset = () => {
    setSelectedCustomer(null);
    setTargetCompanyId('');
    saveLink.reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && saveLink.isPending) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const handleCopyCustomerId = async () => {
    if (!selectedCustomer) return;
    try {
      await navigator.clipboard.writeText(selectedCustomer.id);
      toast.success('Customer ID copiado.');
    } catch {
      toast.error('Não foi possível copiar automaticamente. Selecione o ID exibido e copie manualmente.');
    }
  };

  const handleLink = async () => {
    if (!selectedCustomer || !targetCompany) return;
    if (selectedCustomer.linkedCompanyId) {
      toast.warning('Este cliente Asaas já está vinculado a uma empresa.');
      return;
    }

    try {
      const result = await saveLink.mutateAsync({
        companyId: targetCompany.companyId,
        customerId: selectedCustomer.id,
      });
      toast.success(`Cliente Asaas vinculado a ${targetCompany.companyName}.`);
      if (result.warning) toast.warning(result.warning);
      handleOpenChange(false);
    } catch (error: any) {
      toast.error(error?.message || 'Não foi possível vincular o cliente à empresa.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100vh-1.5rem)] overflow-y-auto p-0 sm:max-w-3xl">
        <div className="border-b border-primary/15 bg-gradient-to-r from-primary/[0.11] via-primary/[0.04] to-transparent px-5 py-5 sm:px-6">
          <DialogHeader className="pr-9">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
              <Search className="h-3.5 w-3.5" />
              Consulta de clientes
            </div>
            <DialogTitle>Localizar Customer ID no Asaas</DialogTitle>
            <DialogDescription className="max-w-2xl leading-relaxed">
              Pesquise por CNPJ, CPF, nome, e-mail ou pelo próprio ID. A consulta é somente leitura e usa o token global protegido no backend.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-4 px-5 pb-5 sm:px-6 sm:pb-6">
          <div className="flex items-start gap-3 rounded-xl border border-success/20 bg-success-soft/35 px-4 py-3 text-sm">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <p className="leading-relaxed text-muted-foreground">
              O token nunca é enviado ao navegador. A lista mostra apenas os dados cadastrais necessários para identificar o cliente correto.
            </p>
          </div>

          <div className="mx-auto w-full max-w-2xl">
            <AsaasCustomerFinder
              selectedCustomerId={selectedCustomer?.id}
              allowLinkedCustomers
              disabled={saveLink.isPending}
              onSelect={(customer) => {
                setSelectedCustomer(customer);
                setTargetCompanyId('');
              }}
            />
          </div>

          {selectedCustomer && (
            <section className="overflow-hidden rounded-xl border border-primary/20 bg-card shadow-sm" aria-live="polite">
              <div className="flex flex-col gap-4 border-b border-border bg-muted/15 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-semibold">{selectedCustomer.name}</p>
                    {selectedCustomer.linkedCompanyId && (
                      <Badge variant="outline" className="border-warning/25 bg-warning-soft text-amber-800">
                        Já vinculado
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[selectedCustomer.cpfCnpj, selectedCustomer.email].filter(Boolean).join(' · ') || 'Sem documento ou e-mail cadastrado'}
                  </p>
                </div>
                <Button type="button" variant="outline" onClick={handleCopyCustomerId} className="shrink-0 gap-2 bg-background">
                  <Copy className="h-4 w-4" />
                  Copiar ID
                </Button>
              </div>

              <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">Customer ID</p>
                  <code className="mt-2 block select-all overflow-x-auto rounded-lg border border-border bg-muted/35 px-3 py-2.5 text-xs font-semibold text-foreground">
                    {selectedCustomer.id}
                  </code>
                </div>

                <div className="rounded-lg border border-border bg-background px-3.5 py-3">
                  <div className="flex items-start gap-2.5">
                    <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">Vincular sem copiar e colar</p>
                      {selectedCustomer.linkedCompanyId ? (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Este cliente já pertence a {linkedCompany?.companyName ?? 'outra empresa'} e não pode ser reutilizado.
                        </p>
                      ) : unconfiguredCompanies.length === 0 ? (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Todas as empresas já possuem um vínculo. Você ainda pode copiar o ID acima.
                        </p>
                      ) : (
                        <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
                          <Select value={targetCompanyId} onValueChange={setTargetCompanyId} disabled={saveLink.isPending}>
                            <SelectTrigger className="min-w-0 flex-1 bg-card">
                              <SelectValue placeholder="Selecione a empresa" />
                            </SelectTrigger>
                            <SelectContent>
                              {unconfiguredCompanies.map((company) => (
                                <SelectItem key={company.companyId} value={company.companyId}>
                                  {company.companyName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            onClick={() => void handleLink()}
                            disabled={!targetCompany || saveLink.isPending}
                            className="shrink-0 gap-2"
                          >
                            {saveLink.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                            Vincular
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
