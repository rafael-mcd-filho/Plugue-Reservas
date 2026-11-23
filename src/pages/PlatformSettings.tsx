import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import ListStateMessage from '@/components/admin/ListStateMessage';
import CentralReservationAsaasCard from '@/components/billing/CentralReservationAsaasCard';
import EvolutionApiCard from '@/components/settings/EvolutionApiCard';
import InternalJobSecretCard from '@/components/settings/InternalJobSecretCard';
import PlatformBillingAsaasCard from '@/components/settings/PlatformBillingAsaasCard';
import SystemBrandingCard from '@/components/settings/SystemBrandingCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePlatformAsaasConfig } from '@/hooks/usePlatformBilling';
import { usePlatformWhatsAppNotices } from '@/hooks/usePlatformWhatsAppNotices';
import { useSystemSettings } from '@/hooks/useSettings';
import { useUrlParam } from '@/hooks/useUrlParam';
import { manageCentralReservationAsaasConfig } from '@/lib/reservation-asaas-config-api';
import { cn } from '@/lib/utils';

type SettingsTab = 'geral' | 'pagamentos' | 'whatsapp' | 'sistema';
const TABS: SettingsTab[] = ['geral', 'pagamentos', 'whatsapp', 'sistema'];
type Tone = 'ok' | 'warning' | 'error' | 'loading';

interface StatusItem {
  id: string;
  name: string;
  label: string;
  tone: Tone;
  tab: SettingsTab;
}

const toneDot: Record<Tone, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-destructive',
  loading: 'bg-muted-foreground/40',
};
const toneText: Record<Tone, string> = {
  ok: 'text-success',
  warning: 'text-amber-800',
  error: 'text-destructive',
  loading: 'text-muted-foreground',
};

export default function PlatformSettings() {
  const [rawTab, setTab] = useUrlParam('aba', 'geral');
  const tab = (TABS as string[]).includes(rawTab) ? (rawTab as SettingsTab) : 'geral';
  const settingsQuery = useSystemSettings();
  const platformAsaasQuery = usePlatformAsaasConfig();
  const centralAsaasQuery = useQuery({
    queryKey: ['central-reservation-asaas-config'],
    queryFn: () => manageCentralReservationAsaasConfig({ action: 'get' }),
  });
  const settings = settingsQuery.data ?? [];
  const settingValue = (key: string) => settings.find((setting) => setting.key === key)?.value || '';

  const platformAsaas = platformAsaasQuery.data;
  const statuses: StatusItem[] = [
    {
      id: 'platform-asaas',
      name: 'Asaas · mensalidades',
      tab: 'pagamentos',
      ...(platformAsaasQuery.isPending
        ? { label: 'Consultando…', tone: 'loading' as Tone }
        : platformAsaasQuery.isError
          ? { label: 'Não foi possível consultar', tone: 'error' as Tone }
          : platformAsaas?.configured
            ? { label: `Conectado em ${platformAsaas.environment === 'production' ? 'produção' : 'sandbox'}`, tone: 'ok' as Tone }
            : platformAsaas?.maskedToken
              ? { label: 'Credencial precisa de validação', tone: 'error' as Tone }
              : { label: 'Não configurado', tone: 'warning' as Tone }),
    },
    {
      id: 'central-asaas',
      name: 'Asaas · reservas',
      tab: 'pagamentos',
      ...(centralAsaasQuery.isPending
        ? { label: 'Consultando…', tone: 'loading' as Tone }
        : centralAsaasQuery.isError
          ? { label: 'Não foi possível consultar', tone: 'error' as Tone }
          : centralAsaasQuery.data?.status === 'configured'
            ? { label: `Conectado em ${centralAsaasQuery.data.environment === 'production' ? 'produção' : 'sandbox'}`, tone: 'ok' as Tone }
            : { label: 'Configuração pendente', tone: 'warning' as Tone }),
    },
    {
      id: 'evolution',
      name: 'Evolution API',
      tab: 'whatsapp',
      ...(settingsQuery.isPending
        ? { label: 'Consultando…', tone: 'loading' as Tone }
        : settingsQuery.isError
          ? { label: 'Não foi possível consultar', tone: 'error' as Tone }
          : settingValue('evolution_api_url') && settingValue('evolution_api_token')
            ? { label: 'Configurada', tone: 'ok' as Tone }
            : { label: 'Não configurada', tone: 'warning' as Tone }),
    },
    {
      id: 'jobs',
      name: 'Rotinas automáticas',
      tab: 'sistema',
      ...(settingsQuery.isPending
        ? { label: 'Consultando…', tone: 'loading' as Tone }
        : settingsQuery.isError
          ? { label: 'Não foi possível consultar', tone: 'error' as Tone }
          : settingValue('internal_job_secret')
            ? { label: 'Segredo configurado', tone: 'ok' as Tone }
            : { label: 'Segredo ausente', tone: 'warning' as Tone }),
    },
  ];
  const tabNeedsAttention = (target: SettingsTab) =>
    statuses.some((status) => status.tab === target && (status.tone === 'warning' || status.tone === 'error'));

  const settingsBody = (content: (loaded: typeof settings) => ReactNode) => {
    if (settingsQuery.isPending) {
      return <Card className="shadow-sm"><CardContent className="space-y-4 p-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></CardContent></Card>;
    }
    if (settingsQuery.isError) {
      return (
        <Card className="shadow-sm">
          <ListStateMessage
            variant="error"
            title="Não foi possível carregar as configurações"
            description="Os campos ficaram ocultos para não salvar valores vazios por cima dos atuais."
            actionLabel="Tentar novamente"
            onAction={() => void settingsQuery.refetch()}
          />
        </Card>
      );
    }
    return content(settings);
  };

  return (
    <div className="space-y-5">
      <AdminPageHeader
        eyebrow="Plataforma"
        title="Configurações"
        description="Identidade da plataforma e conexões externas, separadas por tipo."
      />

      <ul aria-label="Situação das conexões" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {statuses.map((status) => (
          <li key={status.id}>
            <button
              type="button"
              onClick={() => setTab(status.tab)}
              className="flex w-full items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors hover:bg-muted/40"
            >
              <span aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0 rounded-full', toneDot[status.tone])} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{status.name}</span>
                <span className={cn('block text-xs', toneText[status.tone])}>{status.label}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <Tabs value={tab} onValueChange={(value) => setTab(value)}>
        <TabsList aria-label="Seções das configurações" className="h-auto flex-wrap">
          {TABS.map((value) => (
            <TabsTrigger key={value} value={value} className="gap-2">
              {{ geral: 'Geral', pagamentos: 'Pagamentos', whatsapp: 'WhatsApp', sistema: 'Sistema' }[value]}
              {tabNeedsAttention(value) && (
                <span aria-label="precisa de atenção" className="h-1.5 w-1.5 rounded-full bg-warning" />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="geral" className="mt-5">
          {settingsBody((loaded) => <SystemBrandingCard settings={loaded} />)}
        </TabsContent>

        <TabsContent value="pagamentos" className="mt-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            São duas contas Asaas separadas: uma consulta as mensalidades que as empresas pagam à plataforma,
            a outra recebe os pagamentos antecipados das reservas.
          </p>
          <PlatformBillingAsaasCard />
          <CentralReservationAsaasCard />
        </TabsContent>

        <TabsContent value="whatsapp" className="mt-5 space-y-4">
          <PlatformNoticeInstanceCard />
          {settingsBody((loaded) => <EvolutionApiCard settings={loaded} />)}
        </TabsContent>

        <TabsContent value="sistema" className="mt-5">
          {settingsBody((loaded) => <InternalJobSecretCard settings={loaded} />)}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * A instância RWSL envia os avisos da plataforma. Sem uma consulta de status
 * no servidor, mostramos o resultado real do último envio por ela.
 */
function PlatformNoticeInstanceCard() {
  const lastNotice = usePlatformWhatsAppNotices({ enabled: true, offset: 0, limit: 1 });
  const row = lastNotice.data?.rows[0];
  const statusLabel: Record<string, { label: string; className: string }> = {
    accepted: { label: 'Aceito pela instância', className: 'border-success/25 bg-success-soft text-success' },
    failed: { label: 'Falhou', className: 'border-destructive/25 bg-destructive-soft text-destructive' },
    queued: { label: 'Na fila', className: 'border-info/25 bg-info-soft text-info' },
    processing: { label: 'Enviando', className: 'border-info/25 bg-info-soft text-info' },
    unknown: { label: 'Sem confirmação', className: 'border-warning/30 bg-warning-soft text-amber-900' },
    skipped: { label: 'Não enviado', className: 'border-border bg-muted text-muted-foreground' },
  };

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base">Avisos da plataforma (instância RWSL)</CardTitle>
        <CardDescription className="max-w-2xl">
          Os avisos enviados pela tela Avisos saem pela instância RWSL, para o telefone do responsável de cada empresa.
          O teste da Evolution API confirma o servidor, não esta instância.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {lastNotice.isPending ? (
          <Skeleton className="h-6 w-64" />
        ) : lastNotice.isError ? (
          <p className="text-destructive">Não foi possível consultar o último envio.</p>
        ) : !row ? (
          <p className="text-muted-foreground">Nenhum aviso foi enviado pelo WhatsApp ainda.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Último envio:</span>
            <Badge variant="outline" className={statusLabel[row.status]?.className}>{statusLabel[row.status]?.label ?? row.status}</Badge>
            <span>{format(new Date(row.processed_at ?? row.created_at), "dd/MM/yyyy 'às' HH:mm")}</span>
            <span className="text-muted-foreground">· {row.company_name}</span>
          </div>
        )}
        <Button asChild variant="link" className="h-auto p-0 text-accent-foreground">
          <Link to="/notificacoes?canal=whatsapp">Ver envios pelo WhatsApp</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
