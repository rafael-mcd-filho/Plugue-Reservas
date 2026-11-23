import {
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowUpDown,
  Building2,
  Circle,
  Clock,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  ReceiptText,
  ScrollText,
  Search,
  ShieldAlert,
  Trash2,
  Undo2,
  Users,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  COMPANY_DELETION_REQUEST_STATUS_LABEL,
  useCancelCompanyDeletion,
  useCompanies,
  useCompanyDeletionRequests,
  useRequestCompanyDeletion,
  useUpdateCompany,
  type Company,
  type CompanyStatus,
} from '@/hooks/useCompanies';
import { useCompaniesFeatureMatrix, type CompanyFeatureState } from '@/hooks/useCompanyFeatures';
import { getPlanDefaultFeatures, normalizeCompanyPlanTier } from '@/lib/companyFeatures';
import CompanyDialog from '@/components/company/CompanyDialog';
import { CompanyDeletionRecoveryActions } from '@/components/company/CompanyDeletionRecoveryActions';
import { CompanyFeatureSummary } from '@/components/company/CompanyFeatureSwitchList';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import ListPagination from '@/components/admin/ListPagination';
import type { ManagedUser } from '@/hooks/useUsers';
import { useManageUserInvoker } from '@/hooks/useManageUserInvoker';
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

const COMPANY_PAGE_SIZE = 25;

type SortField = 'name' | 'cnpj' | 'status' | 'created_at';
type SortDir = 'asc' | 'desc';

export default function Companies() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user: authUser, loading: authLoading } = useAuth();
  const { data: companies = [], isLoading } = useCompanies();
  const updateCompany = useUpdateCompany();
  const requestDeletion = useRequestCompanyDeletion();
  const cancelDeletion = useCancelCompanyDeletion();
  const { data: deletionRequests = [] } = useCompanyDeletionRequests();
  const { invokeManageUser, manageUserScopeKey } = useManageUserInvoker();
  const { data: featureMatrix = {} } = useCompaniesFeatureMatrix(companies);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [companyPage, setCompanyPage] = useState(1);
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [dialogFeatures, setDialogFeatures] = useState<CompanyFeatureState | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [companyToDelete, setCompanyToDelete] = useState<Company | null>(null);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [impersonationDialogOpen, setImpersonationDialogOpen] = useState(false);
  const [companyToImpersonate, setCompanyToImpersonate] = useState<Company | null>(null);
  const [impersonationDestination, setImpersonationDestination] = useState<'configuracoes' | null>(null);
  const requestedImpersonation = searchParams.get('impersonar');
  const requestedDestination = searchParams.get('destino');

  useEffect(() => {
    if (!requestedImpersonation || isLoading || authLoading || !authUser?.id) return;
    const company = companies.find((item) => item.id === requestedImpersonation);
    const consumed = new URLSearchParams(searchParams);
    consumed.delete('impersonar');
    consumed.delete('destino');
    setSearchParams(consumed, { replace: true });
    if (!company) return;
    setCompanyToImpersonate(company);
    setImpersonationDestination(requestedDestination === 'configuracoes' ? 'configuracoes' : null);
    setImpersonationDialogOpen(true);
  }, [authLoading, authUser?.id, companies, isLoading, requestedDestination, requestedImpersonation, searchParams, setSearchParams]);

  const activeDeletionRequests = deletionRequests.filter((request) =>
    ['grace_period', 'running', 'needs_attention'].includes(request.status));

  const handleDeleteDialogOpenChange = (open: boolean) => {
    if (!open && requestDeletion.isPending) return;

    setDeleteDialogOpen(open);
    if (!open) {
      setCompanyToDelete(null);
      setDeleteConfirmationText('');
      setDeleteReason('');
    }
  };

  const handleConfirmDelete = async () => {
    if (!companyToDelete || requestDeletion.isPending) return;

    try {
      await requestDeletion.mutateAsync({
        companyId: companyToDelete.id,
        confirmationText: deleteConfirmationText,
        reason: deleteReason,
      });
      setDeleteDialogOpen(false);
      setCompanyToDelete(null);
      setDeleteConfirmationText('');
      setDeleteReason('');
    } catch {
      // The mutation displays the translated error and the confirmation stays open.
    }
  };

  const isDeleteConfirmationValid = !!companyToDelete
    && (deleteConfirmationText === companyToDelete.name || deleteConfirmationText === companyToDelete.slug)
    && deleteReason.trim().length > 0;

  const { data: impersonationCandidates = [], isLoading: impersonationCandidatesLoading, isError: impersonationCandidatesError, error: impersonationCandidatesErrorObj } = useQuery({
    queryKey: ['impersonation-candidates', companyToImpersonate?.id, manageUserScopeKey],
    queryFn: async () => {
      const companyId = companyToImpersonate?.id;
      if (!companyId) return [];

      const data = await invokeManageUser<{ users?: ManagedUser[] }>({
        action: 'list_users',
        company_id: companyId,
      });

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
    enabled: impersonationDialogOpen && !!companyToImpersonate?.id && !!authUser && !authLoading,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // O cadastro de uma empresa existente fica na página /empresas/:id;
  // este diálogo serve só para criar empresas novas.
  const openCreate = () => {
    setSelectedCompany(null);
    setDialogFeatures(getPlanDefaultFeatures(normalizeCompanyPlanTier(undefined)));
    setDialogOpen(true);
  };

  const openCompany = (company: Company) => navigate(`/empresas/${company.id}`);

  const openImpersonationDialog = (company: Company) => {
    setCompanyToImpersonate(company);
    setImpersonationDestination(null);
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

    const target = user.effective_role === 'admin' && impersonationDestination === 'configuracoes'
      ? `/${company.slug}/admin/configuracoes/empresa`
      : `/${company.slug}/admin`;
    setImpersonationDialogOpen(false);
    setCompanyToImpersonate(null);
    setImpersonationDestination(null);
    navigate(target);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setSelectedCompany(null);
      setDialogFeatures(null);
    }
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((current) => current === 'asc' ? 'desc' : 'asc');
      return;
    }

    setSortField(field);
    setSortDir('asc');
  };

  const togglePause = (company: Company) => {
    if (company.deletion_requested_at) return;
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
  const companyPageCount = Math.max(1, Math.ceil(filteredCompanies.length / COMPANY_PAGE_SIZE));
  const currentCompanyPage = Math.min(companyPage, companyPageCount);
  const pagedCompanies = filteredCompanies.slice(
    (currentCompanyPage - 1) * COMPANY_PAGE_SIZE,
    currentCompanyPage * COMPANY_PAGE_SIZE,
  );

  const SortHeader = ({ field, children }: { field: SortField; children: ReactNode }) => (
    <Button variant="ghost" size="sm" className="-ml-3 h-auto gap-1 py-1 font-medium" onClick={() => toggleSort(field)}>
      {children}
      <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
    </Button>
  );

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Principal"
        title="Empresas"
        description="Cadastro, situação e recursos das empresas."
        actions={(
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            Nova empresa
          </Button>
        )}
      />

      {activeDeletionRequests.length > 0 && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="space-y-3 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <ShieldAlert className="h-4 w-4" /> Exclusões em andamento
            </p>
            {activeDeletionRequests.map((request) => (
              <div
                key={request.id}
                className="flex flex-col gap-2 rounded-lg border bg-background p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium">{request.company_name_snapshot}</p>
                  <p className="text-xs text-muted-foreground">
                    {COMPANY_DELETION_REQUEST_STATUS_LABEL[request.status]}
                    {request.phase ? ` · fase atual: ${request.phase}` : ''}
                    {request.status === 'grace_period'
                      ? ` · termina ${formatDistanceToNow(new Date(request.grace_period_ends_at), { locale: ptBR, addSuffix: true })}`
                      : ''}
                  </p>
                  {request.last_error && (
                    <p className="mt-1 text-xs text-destructive">{request.last_error}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {request.status === 'grace_period' && (
                    <Button
                      type="button" size="sm" variant="outline" className="gap-1.5"
                      disabled={cancelDeletion.isPending}
                      onClick={() => cancelDeletion.mutate(request.company_id)}
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Cancelar
                    </Button>
                  )}
                  <CompanyDeletionRecoveryActions request={request} />
                  {request.status === 'running' && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" /> Em processamento
                    </span>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, CNPJ ou responsável..."
            value={search}
            onChange={(event) => { setSearch(event.target.value); setCompanyPage(1); }}
            className="pl-10"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {(['all', 'active', 'paused'] as const).map((status) => (
            <Button
              key={status}
              variant={statusFilter === status ? 'default' : 'outline'}
              size="sm"
              onClick={() => { setStatusFilter(status); setCompanyPage(1); }}
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
                <TableHead>Recursos</TableHead>
                <TableHead><SortHeader field="created_at">Cadastro</SortHeader></TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedCompanies.map((company) => {
                const companyStatus = statusConfig[company.status];

                return (
                  <TableRow
                    key={company.id}
                    className="cursor-pointer"
                    onClick={() => openCompany(company)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openCompany(company); }}
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
                      {company.deletion_requested_at ? (
                        <Badge variant="destructive" className="gap-1.5">
                          <ShieldAlert className="h-3 w-3" /> Exclusão em andamento
                        </Badge>
                      ) : (
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${companyStatus.className}`}>
                          <Circle className="h-2 w-2 fill-current" />
                          {companyStatus.label}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <CompanyFeatureSummary features={featureMatrix[company.id]} />
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
                            <DropdownMenuItem onClick={() => openCompany(company)}>
                              <Pencil className="mr-2 h-4 w-4" /> Abrir empresa
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => navigate(`/usuarios?empresa=${company.id}`)}>
                              <Users className="mr-2 h-4 w-4" /> Ver usuários
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate(`/financeiro/empresa/${company.id}`)}>
                              <ReceiptText className="mr-2 h-4 w-4" /> Ver financeiro
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate(`/logs?empresa=${company.id}&periodo=todos`)}>
                              <ScrollText className="mr-2 h-4 w-4" /> Ver ações na auditoria
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => togglePause(company)} disabled={!!company.deletion_requested_at}>
                              {company.status === 'paused' ? (
                                <><Play className="mr-2 h-4 w-4" /> Ativar</>
                              ) : (
                                <><Pause className="mr-2 h-4 w-4" /> Pausar</>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              disabled={!!company.deletion_requested_at}
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
          <ListPagination
            page={currentCompanyPage}
            pageSize={COMPANY_PAGE_SIZE}
            total={filteredCompanies.length}
            onPageChange={setCompanyPage}
            itemLabel={['empresa', 'empresas']}
            className="border-t border-border"
          />
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
          if (!open) {
            setCompanyToImpersonate(null);
            setImpersonationDestination(null);
          }
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
          ) : impersonationCandidatesError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive space-y-1">
              <p className="font-medium">Erro ao carregar usuários:</p>
              <p className="font-mono text-xs break-all">{(impersonationCandidatesErrorObj as any)?.message || 'Erro desconhecido'}</p>
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

      <Dialog open={deleteDialogOpen} onOpenChange={handleDeleteDialogOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Solicitar exclusão permanente</DialogTitle>
            <DialogDescription>
              "{companyToDelete?.name}" entra em um período de carência de 24h, cancelável. Depois disso, um processo
              assíncrono remove os dados em lotes e desprovisiona a instância de WhatsApp e os arquivos no Storage.
              Cobranças e integrações no Asaas <strong>não</strong> são tocadas automaticamente. A ação é irreversível
              após a carência.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="delete-confirmation-text">
                Digite o nome ou o identificador (slug) da empresa para confirmar
              </label>
              <Input
                id="delete-confirmation-text"
                value={deleteConfirmationText}
                onChange={(event) => setDeleteConfirmationText(event.target.value)}
                placeholder={companyToDelete?.name}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="delete-reason">Motivo da exclusão</label>
              <Textarea
                id="delete-reason"
                value={deleteReason}
                onChange={(event) => setDeleteReason(event.target.value)}
                placeholder="Ex.: encerramento de contrato, solicitação do cliente..."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleDeleteDialogOpenChange(false)} disabled={requestDeletion.isPending}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={!isDeleteConfirmationValid || requestDeletion.isPending}
            >
              {requestDeletion.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Solicitando...</>
              ) : (
                'Solicitar exclusão'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
