import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, ExternalLink, Loader2, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useSupportCompanies, useSupportCandidates, type SupportCompany, type SupportCandidate } from '@/hooks/useSupportAccess';
import { startImpersonationSession, type SupportImpersonationContext } from '@/hooks/useImpersonation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function SupportCompanies() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const companiesQuery = useSupportCompanies();
  const [search, setSearch] = useState('');
  const [selectedCompany, setSelectedCompany] = useState<SupportCompany | null>(null);
  const [startingUserId, setStartingUserId] = useState<string | null>(null);
  const candidatesQuery = useSupportCandidates(selectedCompany?.id);
  const companies = companiesQuery.data ?? [];
  const filtered = companies.filter((company) => (company.name + ' ' + company.slug).toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));

  const start = async (candidate: SupportCandidate) => {
    if (!selectedCompany || !user || startingUserId) return;
    setStartingUserId(candidate.user_id);
    try {
      const { data, error } = await (supabase as any).rpc('start_support_impersonation', {
        _company_id: selectedCompany.id, _target_user_id: candidate.user_id,
      });
      if (error) throw error;
      const context = data as SupportImpersonationContext;
      if (!context?.id || context.actorUserId !== user.id || context.companyId !== selectedCompany.id
        || context.userId !== candidate.user_id || !['admin', 'operator'].includes(context.effectiveRole)
        || !Number.isFinite(Date.parse(context.expiresAt)) || Date.parse(context.expiresAt) <= Date.now()) {
        throw new Error('Não foi possível validar o acesso à empresa.');
      }
      await queryClient.cancelQueries();
      queryClient.clear();
      startImpersonationSession({
        ...context, supportSessionId: context.id, status: 'pending', startedAt: new Date().toISOString(),
      });
      navigate('/' + context.companySlug + '/admin');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível iniciar a impersonação.');
    } finally {
      setStartingUserId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-2xl font-bold tracking-tight">Empresas</h1><p className="mt-1 text-sm text-muted-foreground">Escolha uma empresa autorizada para acessar como um dos seus usuários.</p></div>
        <Badge variant="outline" className="gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Acesso de suporte</Badge>
      </div>
      <div className="relative max-w-md"><Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label="Pesquisar empresas" placeholder="Pesquisar por nome ou endereço da página" className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <Card><CardContent className="p-0">
        {companiesQuery.isPending ? <div role="status" className="flex items-center justify-center gap-2 p-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Carregando empresas...</div>
          : companiesQuery.isError ? <div role="alert" className="space-y-3 p-8 text-center"><p>Não foi possível carregar as empresas autorizadas.</p><Button variant="outline" onClick={() => companiesQuery.refetch()}>Tentar novamente</Button></div>
            : filtered.length === 0 ? <div className="space-y-2 p-12 text-center"><Building2 className="mx-auto h-8 w-8 text-muted-foreground" /><p className="font-medium">{companies.length ? 'Nenhuma empresa encontrada' : 'Nenhuma empresa autorizada'}</p><p className="text-sm text-muted-foreground">{companies.length ? 'Experimente outro termo de pesquisa.' : 'O superadmin precisa selecionar as empresas no seu cadastro.'}</p></div>
              : <Table><TableHeader><TableRow><TableHead>Empresa</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Acesso</TableHead></TableRow></TableHeader><TableBody>{filtered.map((company) => <TableRow key={company.id}><TableCell><p className="font-medium">{company.name}</p><p className="text-xs text-muted-foreground">/{company.slug}</p></TableCell><TableCell><Badge variant={company.status === 'active' ? 'secondary' : 'outline'}>{company.status === 'active' ? 'Ativa' : 'Pausada'}</Badge></TableCell><TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => setSelectedCompany(company)}><ExternalLink className="mr-2 h-4 w-4" /> Acessar como usuário</Button></TableCell></TableRow>)}</TableBody></Table>}
      </CardContent></Card>
      <Dialog open={!!selectedCompany} onOpenChange={(open) => { if (!open && !startingUserId) setSelectedCompany(null); }}><DialogContent><DialogHeader><DialogTitle>Acessar {selectedCompany?.name}</DialogTitle><DialogDescription>Selecione um usuário ativo. Você terá as permissões dele durante a impersonação.</DialogDescription></DialogHeader>
        {candidatesQuery.isPending ? <div role="status" className="flex items-center justify-center gap-2 py-8"><Loader2 className="h-5 w-5 animate-spin" /> Carregando usuários...</div>
          : candidatesQuery.isError ? <div role="alert" className="space-y-3 py-4"><p>Não foi possível carregar os usuários. O acesso à empresa pode ter sido removido.</p><Button variant="outline" onClick={() => candidatesQuery.refetch()}>Tentar novamente</Button></div>
            : !candidatesQuery.data?.length ? <p className="py-6 text-center text-sm text-muted-foreground">Nenhum usuário ativo disponível nesta empresa.</p>
              : <div className="max-h-[55vh] space-y-2 overflow-y-auto">{candidatesQuery.data.map((candidate) => <div key={candidate.user_id} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div className="min-w-0"><p className="truncate font-medium">{candidate.full_name || candidate.email}</p><p className="truncate text-xs text-muted-foreground">{candidate.email}</p><Badge variant="secondary" className="mt-1">{candidate.effective_role === 'admin' ? 'Administrador' : 'Operador'}</Badge></div><Button size="sm" disabled={!!startingUserId} onClick={() => start(candidate)}>{startingUserId === candidate.user_id ? <Loader2 aria-label="Iniciando acesso" className="h-4 w-4 animate-spin" /> : 'Acessar'}</Button></div>)}</div>}
      </DialogContent></Dialog>
    </div>
  );
}
