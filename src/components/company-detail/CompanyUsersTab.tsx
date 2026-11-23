import { format, formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Link } from 'react-router-dom';
import ListStateMessage from '@/components/admin/ListStateMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLastPanelAccess } from '@/hooks/useLastPanelAccess';
import type { ManagedUser } from '@/hooks/useUsers';

const ROLE_LABELS: Record<string, string> = { admin: 'Admin', operator: 'Operador', support: 'Suporte', superadmin: 'Superadmin' };

function initials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
}

export default function CompanyUsersTab({
  companyId,
  users,
  isPending,
  isError,
  onRetry,
}: {
  companyId: string;
  users: ManagedUser[];
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const lastAccessQuery = useLastPanelAccess(users.map((user) => user.id), companyId);
  const lastAccess = lastAccessQuery.data ?? {};

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 border-b">
        <CardTitle className="text-base">Pessoas com acesso</CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link to={`/usuarios?empresa=${companyId}`}>Abrir em Usuários</Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {isPending ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((item) => <Skeleton key={item} className="h-12 w-full" />)}</div>
        ) : isError ? (
          <ListStateMessage variant="error" title="Não foi possível carregar os usuários" actionLabel="Tentar novamente" onAction={onRetry} />
        ) : users.length === 0 ? (
          <ListStateMessage variant="empty" title="Nenhuma pessoa com acesso a esta empresa" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Pessoa</TableHead>
                  <TableHead>Perfil</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Último acesso ao painel</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => {
                  const last = lastAccess[user.id];
                  return (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex min-w-[220px] items-center gap-3">
                          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-accent-foreground">
                            {initials(user.full_name || user.email)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{user.full_name || '-'}</p>
                            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {user.roles.map((role) => <Badge key={role} variant="secondary" className="text-xs">{ROLE_LABELS[role] ?? role}</Badge>)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {user.is_banned
                          ? <Badge variant="destructive" className="text-xs">Bloqueada</Badge>
                          : <Badge className="border-success/25 bg-success-soft text-xs text-success hover:bg-success-soft">Ativa</Badge>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {lastAccessQuery.isPending ? <Skeleton className="h-4 w-20" />
                          : lastAccessQuery.isError ? <span className="text-muted-foreground">Indisponível</span>
                            : last ? (
                              <span title={format(new Date(last), "dd/MM/yyyy 'às' HH:mm")}>
                                {formatDistanceToNowStrict(new Date(last), { addSuffix: true, locale: ptBR })}
                              </span>
                            ) : <span className="text-muted-foreground">Nunca acessou</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
