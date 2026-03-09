import { useState, useEffect } from 'react';
import { Smartphone, QrCode, Wifi, WifiOff, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useWhatsAppInstance, useEvolutionApi } from '@/hooks/useAutomations';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface Props {
  companyId: string;
}

export default function WhatsAppConnection({ companyId }: Props) {
  const { data: instance, isLoading } = useWhatsAppInstance(companyId);
  const evolutionApi = useEvolutionApi();
  const qc = useQueryClient();
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const handleConnect = async () => {
    try {
      // Create instance if needed
      if (!instance) {
        await evolutionApi.mutateAsync({ action: 'create_instance', company_id: companyId });
        qc.invalidateQueries({ queryKey: ['whatsapp-instance', companyId] });
      }

      // Get QR code
      const result = await evolutionApi.mutateAsync({ action: 'get_qrcode', company_id: companyId });
      if (result?.base64) {
        setQrCode(result.base64);
        setPolling(true);
      } else if (result?.code) {
        setQrCode(result.code);
        setPolling(true);
      } else {
        toast.error('Não foi possível obter o QR Code. Verifique as configurações da Evolution API.');
      }
    } catch (err: any) {
      toast.error(err.message || 'Erro ao conectar WhatsApp');
    }
  };

  const handleDisconnect = async () => {
    try {
      await evolutionApi.mutateAsync({ action: 'disconnect', company_id: companyId });
      qc.invalidateQueries({ queryKey: ['whatsapp-instance', companyId] });
      setQrCode(null);
      setPolling(false);
      toast.success('WhatsApp desconectado');
    } catch (err: any) {
      toast.error(err.message || 'Erro ao desconectar');
    }
  };

  const checkStatus = async () => {
    try {
      const result = await evolutionApi.mutateAsync({ action: 'check_status', company_id: companyId });
      qc.invalidateQueries({ queryKey: ['whatsapp-instance', companyId] });
      if (result?.instance?.state === 'open') {
        setQrCode(null);
        setPolling(false);
        toast.success('WhatsApp conectado!');
      }
    } catch {
      // silent
    }
  };

  // Poll status when QR is showing
  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, [polling]);

  const isConnected = instance?.status === 'connected';

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-primary" /> Conexão WhatsApp
        </CardTitle>
        <CardDescription>Conecte o WhatsApp para envio automático de mensagens</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1.5">
            {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {isConnected ? 'Conectado' : 'Desconectado'}
          </Badge>
          {instance?.phone_number && (
            <span className="text-sm text-muted-foreground">{instance.phone_number}</span>
          )}
        </div>

        {qrCode && !isConnected && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="p-4 bg-white rounded-xl border border-border">
              {qrCode.startsWith('data:') ? (
                <img src={qrCode} alt="QR Code WhatsApp" className="w-64 h-64" />
              ) : (
                <div className="w-64 h-64 flex items-center justify-center text-center">
                  <p className="text-xs text-muted-foreground break-all font-mono">{qrCode}</p>
                </div>
              )}
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo → Escaneie o QR Code
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Aguardando conexão...
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {!isConnected ? (
            <Button onClick={handleConnect} disabled={evolutionApi.isPending} className="gap-2">
              {evolutionApi.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
              {qrCode ? 'Gerar novo QR' : 'Conectar WhatsApp'}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={checkStatus} disabled={evolutionApi.isPending} className="gap-2">
                <RefreshCw className="h-4 w-4" /> Verificar Status
              </Button>
              <Button variant="destructive" onClick={handleDisconnect} disabled={evolutionApi.isPending} className="gap-2">
                <WifiOff className="h-4 w-4" /> Desconectar
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
