import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowUpDown,
  Building2,
  Circle,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useCompanies, useDeleteCompany, useUpdateCompany, type Company, type CompanyStatus } from '@/hooks/useCompanies';
import { useCompaniesFeatureMatrix, type CompanyFeatureState } from '@/hooks/useCompanyFeatures';
import { getPlanDefaultFeatures, normalizeCompanyPlanTier } from '@/lib/companyFeatures';
import CompanyDialog from '@/components/company/CompanyDialog';
import { CompanyFeatureBadges } from '@/components/company/CompanyFeatureSwitchList';
import { supabase } from '@/integrations/supabase/client';
import type { ManagedUser } from '@/hooks/useUsers';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import { startImpersonationSession } from '@/hooks/useImpersonation';
import { useAuth } from '@/contexts/AuthContext';
import { formatCnpj, normalizeCnpjDigits } from '@/lib/validation';

type CompanyUserRole = 'admin' | 'operator';

type ImpersonationCandidate = ManagedUser & {
  effective_role: CompanyUserRole;
};

const statusConfig: Record<CompanyStatus, { label: string; className: string }> = {
  active: { label: 'Ativa', className: 'bg-success-soft text-success border-success/20' },
  paused: { label: 'Pausada', className: 'bg-primary-soft text-primary border-primary/20' },
};

type SortField = 'name' | 'cnpj' | 'status' | 'created_at';
type SortDir = 'asc' | 'desc';

export default function Companies() {
  const navigate = useNavigate();
  const { id: routeCompanyId } = useParams<{ id?: string }>();
  const { user: authUser } = useAuth();
  const { data: companies = [], isLoading } = useCompanies();
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();
  const { data: featureMatrix = {}, isLoading: featureMatrixLoading } = useCompaniesFeatureMatrix(companies);
  const handledRouteRef = useRef<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [dialogFeatures, setDialogFeatures] = useState<CompanyFeatureState | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [companyToDelete, setCompanyToDelete] = useState<Company | null>(null);
  const [impersonationDialogOpen, setImpersonationDialogOpen] = useState(false);
  const [companyToImpersonate, setCompanyToImpersonate] = useState<Company | null>(null);

  const resolveFeatures = (company: Company) =>
    featureMatrix[company.id] ?? getPlanDefaultFeatures(normalizeCompanyPlanTier(company.plan_tier));

  const { data: impersonationCandidates = [], isLoading: impersonationCandidatesLoading } = useQuery({
    queryKey: ['impersonation-candidates', companyToImpersonate?.id],
    queryFn: async () => {
      const companyId = companyToImpersonate?.id;
      if (!companyId) return [];

      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'list_users',
          company_id: companyId,
        },
      });

      if (error) throw new Error(await getFunctionErrorMessage(error));

      return ((data?.users ?? []) as ManagedUser[])
        .filter((user) => !user.is_banned)
        .map((user) => {
          const effectiveRole: CompanyUserRole = user.roles.includes('admin') ? 'admin' : 'operator';
          return {
            ...user,
            effective_role: effectiveRole,
          };
        })
        .filter((user) => user.roles.includes('admin') || user.roles.includes('operator'))
        .sort((userA, userB) => {
          if (userA.effective_role !== userB.effective_role) {
            return userA.effective_role === 'admin' ? -1 : 1;
          }

          return (userA.full_name || userA.email).localeCompare(userB.full_name || userB.email);
        });
    },
    enabled: impersonationDialogOpen && !!companyToImpersonate?.id,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const resetDialogState = () => {
    setDialogOpen(false);
    setSelectedCompany(null);
    setDialogFeatures(null);
  };

  const openCreate = () => {
    handledRouteRef.current = null;
    setSelectedCompany(null);
    setDialogFeatures(getPlanDefaultFeatures(normalizeCompanyPlanTier(undefined)));
    setDialogOpen(true);
  };

  const openEdit = (company: Company) => {
    setSelectedCompany(company);
    setDialogFeatures(resolveFeatures(company));
    setDialogOpen(true);
  };

  const openImpersonationDialog = (company: Company) => {
    setCompanyToImpersonate(company);
    setImpersonationDialogOpen(true);
  };

  const handleStartImpersonation = (company: Company, user: ImpersonationCandidate) => {
    if (!authUser?.id) {
      return;
    }

    startImpersonationSession({
      actorUserId: authUser.id,
      companyId: company.id,
      companySlug: company.slug,
      companyName: company.name,
      userId: user.id,
      userName: user.full_name || user.email,
      userEmail: user.email,
      effectiveRole: user.effective_role,
      status: 'pending',
      startedAt: new Date().toISOString(),
    });

    setImpersonationDialogOpen(false);
    setCompanyToImpersonate(null);
    navigate(`/${company.slug}/admin`);
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      setDialogOpen(true);
      return;
    }

    resetDialogState();

    if (routeCompanyId) {
      navigate('/empresas', { replace: true });
    }
  };

  useEffect(() => {
    if (!routeCompanyId) {
      handledRouteRef.current = null;
      return;
    }

    if (isLoading || featureMatrixLoading) return;

    const company = companies.find((item) => item.id === routeCompanyId);

    if (!company) {
      resetDialogState();
      navigate('/empresas', { replace: true });
      return;
    }

    if (handledRouteRef.current === routeCompanyId && dialogOpen && selectedCompany?.id === routeCompanyId) {
      return;
    }

    openEdit(company);
    handledRouteRef.current = routeCompanyId;
  }, [routeCompanyId, isLoading, featureMatrixLoading, companies, dialogOpen, navigate, selectedCompany?.id]);

  useEffect(() => {
    if (!routeCompanyId && selectedCompany && dialogOpen) {
      resetDialogState();
    }
  }, [routeCompanyId, dialogOpen, selectedCompany]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((current) => current === 'asc' ? 'desc' : 'asc');
      return;
    }

    setSortField(field);
    setSortDir('asc');
  };

  const togglePause = (company: Company) => {
    const newStatus: CompanyStatus = company.status === 'paused' ? 'active' : 'paused';
    updateCompany.mutate({ id: company.id, status: newStatus });
  };

  const counts = {
    all: companies.length,
    active: companies.filter((company) => company.status === 'active').length,
    paused: companies.filter((company) => company.status === 'paused').length,
  };

  const filteredCompanies = companies
    .filter((company) => statusFilter === 'all' || company.status === statusFilter)
    .filter((company) => {
      const normalizedSearch = search.toLowerCase();
      const cnpjDigits = normalizeCnpjDigits(search);

      return company.name.toLowerCase().includes(normalizedSearch)
        || (!!company.cnpj && (
          company.cnpj.includes(search)
          || (!!cnpjDigits && normalizeCnpjDigits(company.cnpj).includes(cnpjDigits))
        ))
        || (!!company.responsible_name && company.responsible_name.toLowerCase().includes(normalizedSearch));
    })
    .sort((companyA, companyB) => {
      const direction = sortDir === 'asc' ? 1 : -1;
      const valueA = companyA[sortField] ?? '';
      const valueB = companyB[sortField] ?? '';
      return valueA < valueB ? -direction : valueA > valueB ? direction : 0;
    });

  const SortHeader = ({ field, children }: { field: SortField; children: ReactNode }) => (
    <Button variant="ghost" size="sm" className="-ml-3 h-auto gap-1 py-1 font-medium" onClick={() => toggleSort(field)}>
      {children}
      <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
    </Button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Empresas</h1>
          <p className="mt-1 text-muted-foreground">Gerencie cadastro, configurações e recursos das empresas.</p>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus className="h-4 w-4" />
          Nova Empresa
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, CNPJ ou responsável..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {(['all', 'active', 'paused'] as const).map((status) => (
            <Button
              key={status}
              variant={statusFilter === status ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(status)}
              className="gap-1.5"
            >
              {status === 'all' ? 'Todas' : statusConfig[status].label}
              <span className="text-xs opacity-70">({counts[status]})</span>
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Card className="border-none shadow-sm">
          <CardContent className="p-0">
            <div className="space-y-3 p-6">
              {[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-12 w-full" />)}
            </div>
          </CardContent>
        </Card>
      ) : filteredCompanies.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Building2 className="mx-auto mb-3 h-12 w-12 opacity-30" />
            {search || statusFilter !== 'all' ? 'Nenhuma empresa encontrada' : 'Nenhuma empresa cadastrada ainda.'}
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-none shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead><SortHeader field="name">Nome Fantasia</SortHeader></TableHead>
                <TableHead><SortHeader field="cnpj">CNPJ</SortHeader></TableHead>
                <TableHead><SortHeader field="status">Status</SortHeader></TableHead>
                <TableHead>Features</TableHead>
                <TableHead><SortHeader field="created_at">Cadastro</SortHeader></TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCompanies.map((company) => {
                const companyStatus = statusConfig[company.status];

                return (
                  <TableRow
                    key={company.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/empresas/${company.id}`)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/empresas/${company.id}`); }}
                  >
                    <TableCell>
                      <div>
                        <p className="font-medium">{company.name}</p>
                        {company.razao_social && (
                          <p className="max-w-[240px] truncate text-xs text-muted-foreground">{company.razao_social}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {company.cnpj ? formatCnpj(company.cnpj) : '-'}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${companyStatus.className}`}>
                        <Circle className="h-2 w-2 fill-current" />
                        {companyStatus.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <CompanyFeatureBadges features={featureMatrix[company.id]} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(company.created_at), 'dd/MM/yyyy', { locale: ptBR })}
                    </TableCell>
                    <TableCell className="text-right">
                      <div onClick={(event) => event.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Ações para ${company.name}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openImpersonationDialog(company)}>
                              <ExternalLink className="mr-2 h-4 w-4" /> Escolher impersonação
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate(`/empresas/${company.id}`)}>
                              <Pencil className="mr-2 h-4 w-4" /> Editar e configurar
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => togglePause(company)}>
                              {company.status === 'paused' ? (
                                <><Play className="mr-2 h-4 w-4" /> Ativar</>
                              ) : (
                                <><Pause className="mr-2 h-4 w-4" /> Pausar</>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => {
                                setCompanyToDelete(company);
                                setDeleteDialogOpen(true);
                              }}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <CompanyDialog
        open={dialogOpen}
        company={selectedCompany}
        initialFeatures={dialogFeatures}
        onOpenChange={handleDialogOpenChange}
      />

      <Dialog
        open={impersonationDialogOpen}
        onOpenChange={(open) => {
          setImpersonationDialogOpen(open);
          if (!open) setCompanyToImpersonate(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Escolher impersonação</DialogTitle>
            <DialogDescription>
              Selecione o usuário da empresa que será impersonado. O painel respeitará o papel efetivo dele.
            </DialogDescription>
          </DialogHeader>

          {impersonationCandidatesLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Carregando usuários da empresa...
            </div>
          ) : !companyToImpersonate ? null : impersonationCandidates.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Nenhum usuário ativo disponível para impersonação nesta empresa.
            </div>
          ) : (
            <div className="space-y-3">
              {impersonationCandidates.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors hover:bg-muted"
                  onClick={() => handleStartImpersonation(companyToImpersonate, user)}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{user.full_name || user.email}</p>
                    <p className="truncate text-sm text-muted-foreground">{user.email}</p>
                  </div>
                  <span className="rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    {user.effective_role === 'admin' ? 'Admin' : 'Operador'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir empresa permanentemente?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso removerá "{companyToDelete?.name}" e os dados associados. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (companyToDelete) deleteCompany.mutate(companyToDelete.id);
                setDeleteDialogOpen(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir permanentemente
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
