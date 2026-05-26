import { useState } from 'react';
import { Eye, EyeOff, KeyRound, Phone, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { usePlugueChatConfig, useSavePlugueChatConfig } from '@/hooks/usePlugueChatConfig';
import type { WhatsAppChannel } from '@/hooks/useWhatsAppChannel';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
}

export default function PlugueChatConnection({ companyId, activeChannel }: Props) {
  const { data: config, isLoading } = usePlugueChatConfig(companyId);
  const saveConfig = useSavePlugueChatConfig();

  const [fromNumber, setFromNumber] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!hydrated && config) {
    setFromNumber(config.from_number ?? '');
    setHydrated(true);
  }

  const isConfigured = config?.status === 'configured' || (config && config.from_number !== '');

  const handleSave = () => {
    if (!fromNumber.trim()) return;

    saveConfig.mutate({
      company_id: companyId,
      from_number: fromNumber.trim(),
      ...(apiToken.trim() ? { api_token: apiToken.trim() } : {}),
    });

    setApiToken('');
  };

  return (
    <div className="space-y-4">
      {activeChannel !== 'pluguechat_official' && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          O canal ativo não é o PlugueChat Oficial. Alterações aqui não afetarão o envio de mensagens até o canal ser ativado.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Phone className="h-5 w-5 text-primary" /> Número remetente
          </CardTitle>
          <CardDescription>
            Número configurado na API oficial do WhatsApp. Use o formato internacional sem espaços (ex: 5585999999999).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="from-number">Número remetente</Label>
            <Input
              id="from-number"
              value={fromNumber}
              onChange={(e) => setFromNumber(e.target.value)}
              placeholder="5585999999999"
            />
          </div>

          {isConfigured && (
            <p className="text-xs text-muted-foreground">
              Status: <span className="font-medium text-green-600">Configurado</span>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-5 w-5 text-primary" /> Token da API
          </CardTitle>
          <CardDescription>
            {isConfigured
              ? 'Um token já está salvo. Preencha abaixo apenas se quiser substituí-lo.'
              : 'Informe o token de acesso da API oficial do WhatsApp.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="api-token">{isConfigured ? 'Novo token (opcional)' : 'Token da API'}</Label>
            <div className="flex gap-2">
              <Input
                id="api-token"
                type={showToken ? 'text' : 'password'}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder={isConfigured ? '••••••••••••••••' : 'Cole o token aqui'}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {config?.last_error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              Última falha registrada. Verifique o número e o token e salve novamente.
            </div>
          )}

          <Button
            onClick={handleSave}
            disabled={saveConfig.isPending || !fromNumber.trim()}
            size="sm"
            className="gap-2"
          >
            <Save className="h-4 w-4" /> Salvar configuração
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
