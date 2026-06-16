import { useState, useCallback, useEffect, useRef } from 'react';
import { Smartphone, QrCode, Wifi, WifiOff, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useWhatsAppInstance, useEvolutionApi } from '@/hooks/useAutomations';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface Props {
  companyId: string;
  embedded?: boolean;
  autoStart?: boolean;
  onConnected?: () => void;
}

export default function WhatsAppConnection({ companyId, embedded = false, autoStart = false, onConnected }: Props) {
  const { data: instance, isLoading } = useWhatsAppInstance(companyId);
  const { mutateAsync: invokeEvolutionApi, isPending: evolutionApiPending } = useEvolutionApi();
  const qc = useQueryClient();
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const autoStartAttempted = useRef(false);

  const handleConnect = useCallback(async () => {
    try {
      if (!instance) {
        const createResult = await invokeEvolutionApi({ action: 'create_instance', company_id: companyId });
        qc.invalidateQueries({ queryKey: ['whatsapp-instance', companyId] });

        if (createResult?.base64) {
          const src = createResult.base64.startsWith('data:') ? createResult.base64 : `data:image/png;base64,${createResult.base64}`;
          setQrCode(src);
          setPairingCode(createResult.pairingCode || createResult.code || null);
          setPolling(true);
          return;
        }
      }

      const result = await invokeEvolutionApi({ action: 'get_qrcode', company_id: companyId });

      if (result?.base64) {
        const src = result.base64.startsWith('data:') ? result.base64 : `data:image/png;base64,${result.base64}`;
        setQrCode(src);
        setPairingCode(result.pairingCode || null);
        setPolling(true);
      } else if (result?.pairingCode || result?.code) {
        setPairingCode(result.pairingCode || result.code);
        setQrCode(null);
        setPolling(true);
      } else {
        toast.error('Não foi possível obter o QR Code. Verifique as configurações da Evolution API.');
      }
    } catch (err: any) {
      toast.error(err.message || 'Erro ao conectar WhatsApp');
    }
  }, [companyId, instance, invokeEvolutionApi, qc]);

  const handleDisconnect = async () => {
    try {
      await invokeEvolutionApi({ action: 'disconnect', company_id: companyId });
      qc.invalidateQueries({ queryKey: ['whatsapp-instance', companyId] });
      qc.invalidateQueries({ queryKey: ['whatsapp-instance-status', companyId] });
      setQrCode(null);
      setPairingCode(null);
      setPolling(false);
      toast.success('WhatsApp desconectado');
    } catch (err: any) {
      toast.error(err.message || 'Erro ao desconectar');
    }
  };

  const checkStatus = useCallback(async (options?: { refreshProfile?: boolean; silent?: boolean }) => {
    setCheckingStatus(true);
    try {
      const result = await invokeEvolutionApi({
        action: 'check_status',
        company_id: companyId,
        refresh_profile: options?.refreshProfile ?? false,
      });
      qc.invalidateQueries({ queryKey: ['whatsapp-instance', companyId] });
      qc.invalidateQueries({ queryKey: ['whatsapp-instance-status', companyId] });
      if (result?.instance?.state === 'open') {
        setQrCode(null);
        setPairingCode(null);
        setPolling(false);
        if (!options?.silent) toast.success('WhatsApp conectado!');
        onConnected?.();
      } else if (!options?.silent) {
        toast.warning('WhatsApp não está conectado no momento.');
      }
    } catch (err: any) {
      if (!options?.silent) {
        toast.error(err.message || 'Não foi possível verificar o status agora.');
      }
    } finally {
      setCheckingStatus(false);
    }
  }, [companyId, invokeEvolutionApi, onConnected, qc]);

  useEffect(() => {
    if (!polling) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkStatus({ refreshProfile: true, silent: true });
      }
    };

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void checkStatus({ refreshProfile: true, silent: true });
      }
    }, 5000);

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkStatus, polling]);

  const isConnected = instance?.status === 'connected';

  useEffect(() => {
    if (!autoStart || autoStartAttempted.current || isLoading || isConnected || qrCode || pairingCode || evolutionApiPending) {
      return;
    }

    autoStartAttempted.current = true;
    void handleConnect();
  }, [autoStart, evolutionApiPending, handleConnect, isConnected, isLoading, pairingCode, qrCode]);

  const connectionContent = (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1.5">
          {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {isConnected ? 'Conectado' : 'Desconectado'}
        </Badge>
      </div>

      {isConnected && (instance?.display_name || instance?.phone_number || instance?.profile_picture_url) && (
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
          {instance.profile_picture_url ? (
            <img
              src={instance.profile_picture_url}
              alt="Foto do WhatsApp"
              className="h-10 w-10 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Smartphone className="h-5 w-5 text-primary" />
            </div>
          )}
          <div className="min-w-0">
            {instance.display_name && (
              <p className="truncate text-sm font-medium text-foreground">{instance.display_name}</p>
            )}
            {instance.phone_number && (
              <p className="truncate text-xs text-muted-foreground">{instance.phone_number}</p>
            )}
          </div>
        </div>
      )}

      {(qrCode || pairingCode) && !isConnected && (
        <div className="flex flex-col items-center gap-3 py-4">
          {qrCode && (
            <div className="rounded-md border border-border bg-white p-4">
              <img src={qrCode} alt="QR Code WhatsApp" className="h-64 w-64" />
            </div>
          )}
          {pairingCode && (
            <div className="space-y-1 text-center">
              <p className="text-xs text-muted-foreground">Ou use o código de pareamento:</p>
              <p className="font-mono text-2xl font-bold tracking-wider text-foreground">{pairingCode}</p>
            </div>
          )}
          <p className="text-center text-sm text-muted-foreground">
            Abra o WhatsApp, acesse Dispositivos conectados, toque em Conectar dispositivo e escaneie o QR Code.
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Aguardando conexão...
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!isConnected ? (
          <Button onClick={handleConnect} disabled={evolutionApiPending} className="gap-2">
            {evolutionApiPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
            {qrCode || pairingCode ? 'Gerar novo QR' : 'Conectar WhatsApp'}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() => checkStatus({ refreshProfile: false })}
              disabled={evolutionApiPending || checkingStatus}
              className="gap-2"
            >
              {checkingStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {checkingStatus ? 'Verificando...' : 'Verificar status'}
            </Button>
            <Button variant="destructive" onClick={handleDisconnect} disabled={evolutionApiPending} className="gap-2">
              <WifiOff className="h-4 w-4" /> Desconectar
            </Button>
          </>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return connectionContent;
  }

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="h-5 w-5 text-primary" /> Conexão WhatsApp
        </CardTitle>
        <CardDescription>Conecte o WhatsApp para envio automático de mensagens</CardDescription>
      </CardHeader>
      <CardContent>{connectionContent}</CardContent>
    </Card>
  );
}
