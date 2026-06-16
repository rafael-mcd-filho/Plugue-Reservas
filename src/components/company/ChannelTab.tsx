import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Radio, ShieldCheck, Smartphone, Wifi, WifiOff } from 'lucide-react';
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
import { useEvolutionApi, useWhatsAppInstance } from '@/hooks/useAutomations';
import { useQueryClient } from '@tanstack/react-query';
import PlugueChatConnection from './PlugueChatConnection';
import WhatsAppConnection from './WhatsAppConnection';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
}

export default function ChannelTab({ companyId, activeChannel }: Props) {
  const queryClient = useQueryClient();
  const switchChannel = useSwitchWhatsAppChannel();
  const { mutateAsync: refreshEvolutionProfile } = useEvolutionApi();
  const profileRefreshAttempted = useRef(false);
  const [pendingChannel, setPendingChannel] = useState<WhatsAppChannel | null>(null);
  const [evolutionDialogOpen, setEvolutionDialogOpen] = useState(false);
  const [plugueChatDialogOpen, setPlugueChatDialogOpen] = useState(false);

  const { data: instance } = useWhatsAppInstance(companyId);
  const { data: plugueChatConfig } = usePlugueChatConfig(companyId);

  const isEvolution = activeChannel === 'evolution';
  const isPlugueChat = activeChannel === 'pluguechat_official';

  const evolutionConnected = instance?.status === 'connected';
  const plugueChatConfigured = !!(plugueChatConfig?.from_number && plugueChatConfig.status === 'configured');
  const canActivatePlugueChat = plugueChatConfigured && !switchChannel.isPending;

  useEffect(() => {
    if (!evolutionConnected || instance?.display_name || profileRefreshAttempted.current) return;

    profileRefreshAttempted.current = true;
    void refreshEvolutionProfile({
      action: 'check_status',
      company_id: companyId,
      refresh_profile: true,
    }).finally(() => {
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-instance', companyId] });
    });
  }, [companyId, evolutionConnected, instance?.display_name, queryClient, refreshEvolutionProfile]);

  const handleConfirmSwitch = () => {
    if (!pendingChannel) return;
    switchChannel.mutate(
      { company_id: companyId, channel: pendingChannel, expected_channel: activeChannel },
      { onSettled: () => setPendingChannel(null) },
    );
  };

  const handleEvolutionPrimaryAction = () => {
    if (isEvolution || !evolutionConnected) {
      setEvolutionDialogOpen(true);
      return;
    }

    setPendingChannel('evolution');
  };

  const handlePlugueChatPrimaryAction = () => {
    if (isPlugueChat || !plugueChatConfigured) {
      setPlugueChatDialogOpen(true);
      return;
    }

    setPendingChannel('pluguechat_official');
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Canal ativo</h3>
        <p className="text-sm text-muted-foreground">
          Apenas um canal envia mensagens por vez. A conexão, as credenciais e o histórico de cada provedor ficam preservados.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className={`border-2 transition-colors ${isEvolution ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}>
          <CardHeader className="space-y-2 pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Smartphone className="h-5 w-5 text-primary" /> WhatsApp conectado
              </CardTitle>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant="outline" className="gap-1 border-orange-200 bg-orange-50 text-orange-700">
                  <AlertTriangle className="h-3 w-3" /> QR Code
                </Badge>
                {isEvolution && <CheckCircle2 className="h-5 w-5 text-primary" />}
              </div>
            </div>
            <CardDescription>
              Conexão pela Evolution API. Use quando quiser enviar mensagens livres pelo WhatsApp conectado.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {evolutionConnected ? (
                <>
                  <Wifi className="h-3.5 w-3.5 text-green-600" />
                  <span className="text-green-700">Conectado</span>
                </>
              ) : instance ? (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-destructive" />
                  <span className="text-destructive">Desconectado</span>
                </>
              ) : (
                <>
                  <WifiOff className="h-3.5 w-3.5" />
                  <span>Não configurado</span>
                </>
              )}
              {isEvolution && <span className="ml-auto font-medium text-primary">Canal ativo</span>}
            </div>

            {evolutionConnected && (instance?.display_name || instance?.phone_number || instance?.profile_picture_url) && (
              <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5">
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
                  {instance.display_name && <p className="truncate text-sm font-medium">{instance.display_name}</p>}
                  {instance.phone_number && <p className="truncate text-xs text-muted-foreground">{instance.phone_number}</p>}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={isEvolution || !evolutionConnected ? 'default' : 'outline'}
                onClick={handleEvolutionPrimaryAction}
                disabled={switchChannel.isPending}
              >
                {isEvolution
                  ? evolutionConnected ? 'Gerenciar conexão' : 'Conectar WhatsApp'
                  : evolutionConnected ? 'Ativar este canal' : 'Conectar WhatsApp'}
              </Button>
              {!isEvolution && evolutionConnected && (
                <Button size="sm" variant="ghost" onClick={() => setEvolutionDialogOpen(true)}>
                  Ver conexão
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className={`border-2 transition-colors ${isPlugueChat ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}>
          <CardHeader className="space-y-2 pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Radio className="h-5 w-5 text-primary" /> PlugueChat Oficial
              </CardTitle>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant="outline" className="gap-1 border-green-200 bg-green-50 text-green-700">
                  <ShieldCheck className="h-3 w-3" /> Oficial
                </Badge>
                {isPlugueChat && <CheckCircle2 className="h-5 w-5 text-primary" />}
              </div>
            </div>
            <CardDescription>
              API oficial do WhatsApp com templates aprovados pela Meta. Use quando o disparo deve sair pelo PlugueChat.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {plugueChatConfigured ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                  <span className="text-green-700">Configurado - {plugueChatConfig?.from_number}</span>
                </>
              ) : (
                <>
                  <KeyRound className="h-3.5 w-3.5 text-destructive" />
                  <span className="text-destructive">Faltam número e token</span>
                </>
              )}
              {isPlugueChat && <span className="ml-auto font-medium text-primary">Canal ativo</span>}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={isPlugueChat || !plugueChatConfigured ? 'default' : 'outline'}
                onClick={handlePlugueChatPrimaryAction}
                disabled={!isPlugueChat && plugueChatConfigured && !canActivatePlugueChat}
              >
                {isPlugueChat
                  ? 'Configurar PlugueChat'
                  : plugueChatConfigured ? 'Ativar este canal' : 'Configurar PlugueChat'}
              </Button>
              {!isPlugueChat && plugueChatConfigured && (
                <Button size="sm" variant="ghost" onClick={() => setPlugueChatDialogOpen(true)}>
                  Editar credenciais
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={evolutionDialogOpen} onOpenChange={setEvolutionDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Conexão WhatsApp</DialogTitle>
            <DialogDescription>
              Leia o QR Code para conectar a instância Evolution desta unidade.
            </DialogDescription>
          </DialogHeader>
          <WhatsAppConnection
            companyId={companyId}
            embedded
            autoStart={!evolutionConnected}
            onConnected={() => setEvolutionDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={plugueChatDialogOpen} onOpenChange={setPlugueChatDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Configurar PlugueChat</DialogTitle>
            <DialogDescription>
              Informe o número remetente e o token da API oficial. Depois de salvar, o canal pode ser ativado aqui mesmo.
            </DialogDescription>
          </DialogHeader>
          <PlugueChatConnection
            companyId={companyId}
            activeChannel={activeChannel}
            embedded
            onSaved={() => setPlugueChatDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

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
