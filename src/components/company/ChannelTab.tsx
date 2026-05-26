import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Radio, ShieldCheck, Smartphone, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePlugueChatConfig } from '@/hooks/usePlugueChatConfig';
import { type WhatsAppChannel, useSwitchWhatsAppChannel } from '@/hooks/useWhatsAppChannel';
import { useWhatsAppInstance } from '@/hooks/useAutomations';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
}

export default function ChannelTab({ companyId, activeChannel }: Props) {
  const switchChannel = useSwitchWhatsAppChannel();
  const [pendingChannel, setPendingChannel] = useState<WhatsAppChannel | null>(null);

  const { data: instance } = useWhatsAppInstance(companyId);
  const { data: plugueChatConfig } = usePlugueChatConfig(companyId);

  const isEvolution = activeChannel === 'evolution';
  const isPlugueChat = activeChannel === 'pluguechat_official';

  const evolutionConnected = instance?.status === 'connected';
  const plugueChatConfigured = !!(plugueChatConfig?.from_number && plugueChatConfig.status === 'configured');
  const canActivatePlugueChat = plugueChatConfigured && !switchChannel.isPending;

  const handleConfirmSwitch = () => {
    if (!pendingChannel) return;
    switchChannel.mutate(
      { company_id: companyId, channel: pendingChannel, expected_channel: activeChannel },
      { onSettled: () => setPendingChannel(null) },
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Canal ativo</h3>
        <p className="text-sm text-muted-foreground">
          Apenas um canal envia mensagens por vez. Ao trocar, o outro fica pausado, mas suas configurações e histórico são mantidos.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* WhatsApp conectado */}
        <Card className={`border-2 transition-colors ${isEvolution ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}>
          <CardHeader className="space-y-2 pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Smartphone className="h-5 w-5 text-primary" /> WhatsApp conectado
              </CardTitle>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant="outline" className="gap-1 border-orange-200 bg-orange-50 text-orange-700">
                  <AlertTriangle className="h-3 w-3" /> Risco
                </Badge>
                {isEvolution && <CheckCircle2 className="h-5 w-5 text-primary" />}
              </div>
            </div>
            <CardDescription>
              Conexão via QR Code. Mensagens com texto livre, sem aprovação da Meta.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {evolutionConnected ? (
                <>
                  <Wifi className="h-3.5 w-3.5 text-green-600" />
                  <span className="text-green-700">Conectado</span>
                </>
              ) : instance ? (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-destructive" />
                  <span className="text-destructive">Desconectado — reconecte na aba Conexão</span>
                </>
              ) : (
                <>
                  <WifiOff className="h-3.5 w-3.5" />
                  <span>Não configurado</span>
                </>
              )}
            </div>
            {isEvolution ? (
              <span className="text-xs font-medium text-primary">Canal ativo</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPendingChannel('evolution')}
                disabled={switchChannel.isPending}
              >
                Ativar este canal
              </Button>
            )}
          </CardContent>
        </Card>

        {/* PlugueChat Oficial */}
        <Card className={`border-2 transition-colors ${isPlugueChat ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}>
          <CardHeader className="space-y-2 pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Radio className="h-5 w-5 text-primary" /> PlugueChat Oficial
              </CardTitle>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant="outline" className="gap-1 border-green-200 bg-green-50 text-green-700">
                  <ShieldCheck className="h-3 w-3" /> Seguro
                </Badge>
                {isPlugueChat && <CheckCircle2 className="h-5 w-5 text-primary" />}
              </div>
            </div>
            <CardDescription>
              API oficial do WhatsApp com templates aprovados pela Meta. Sem risco de bloqueio.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {plugueChatConfigured ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                  <span className="text-green-700">Configurado — {plugueChatConfig?.from_number}</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>Não configurado — preencha token e número na aba Conexão</span>
                </>
              )}
            </div>
            {isPlugueChat ? (
              <span className="text-xs font-medium text-primary">Canal ativo</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPendingChannel('pluguechat_official')}
                disabled={!canActivatePlugueChat}
              >
                {plugueChatConfigured ? 'Ativar este canal' : 'Configure antes de ativar'}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!pendingChannel} onOpenChange={(open) => { if (!open) setPendingChannel(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trocar canal de envio?</DialogTitle>
            <DialogDescription>
              {pendingChannel === 'pluguechat_official'
                ? 'Ao ativar o PlugueChat Oficial, mensagens do WhatsApp conectado serão pausadas. Filas e disparos pendentes do canal anterior serão cancelados.'
                : 'Ao ativar o WhatsApp conectado, mensagens do PlugueChat Oficial serão pausadas. Filas e disparos pendentes do canal anterior serão cancelados.'}
              {' '}Configurações e histórico de ambos os canais são mantidos.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingChannel(null)} disabled={switchChannel.isPending}>
              Cancelar
            </Button>
            <Button onClick={handleConfirmSwitch} disabled={switchChannel.isPending}>
              {switchChannel.isPending ? 'Trocando...' : 'Confirmar troca'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
