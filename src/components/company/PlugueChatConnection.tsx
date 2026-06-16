import { useEffect, useState } from 'react';
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
  embedded?: boolean;
  onSaved?: () => void;
}

export default function PlugueChatConnection({ companyId, activeChannel, embedded = false, onSaved }: Props) {
  const { data: config, isLoading } = usePlugueChatConfig(companyId);
  const saveConfig = useSavePlugueChatConfig();

  const [fromNumber, setFromNumber] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    setFromNumber(config?.from_number ?? '');
  }, [config?.from_number]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const isConfigured = config?.status === 'configured' && !!config.from_number;

  const handleSave = () => {
    if (!fromNumber.trim()) return;

    saveConfig.mutate(
      {
        company_id: companyId,
        from_number: fromNumber.trim(),
        ...(apiToken.trim() ? { api_token: apiToken.trim() } : {}),
      },
      {
        onSuccess: () => {
          setApiToken('');
          onSaved?.();
        },
      },
    );
  };

  const formContent = (
    <div className="space-y-4">
      {!embedded && activeChannel !== 'pluguechat_official' && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          O canal ativo não é o PlugueChat Oficial. Alterações aqui só afetarão o envio quando o canal for ativado.
        </div>
      )}

      <div className={embedded ? 'space-y-4' : 'grid gap-4 xl:grid-cols-2'}>
        <div className={embedded ? 'space-y-2' : 'rounded-lg border border-border p-4'}>
          {!embedded && (
            <div className="mb-3 space-y-1">
              <h4 className="flex items-center gap-2 text-sm font-semibold">
                <Phone className="h-4 w-4 text-primary" /> Número remetente
              </h4>
              <p className="text-xs text-muted-foreground">
                Use o formato internacional sem espaços, por exemplo 5585999999999.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="from-number">Número remetente</Label>
            <Input
              id="from-number"
              value={fromNumber}
              onChange={(e) => setFromNumber(e.target.value)}
              placeholder="5585999999999"
            />
            {embedded && (
              <p className="text-xs text-muted-foreground">Use o formato internacional sem espaços.</p>
            )}
          </div>
        </div>

        <div className={embedded ? 'space-y-2' : 'rounded-lg border border-border p-4'}>
          {!embedded && (
            <div className="mb-3 space-y-1">
              <h4 className="flex items-center gap-2 text-sm font-semibold">
                <KeyRound className="h-4 w-4 text-primary" /> Token da API
              </h4>
              <p className="text-xs text-muted-foreground">
                {isConfigured
                  ? 'Um token já está salvo. Preencha abaixo apenas se quiser substituí-lo.'
                  : 'Informe o token de acesso da API oficial do WhatsApp.'}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="api-token">{isConfigured ? 'Novo token (opcional)' : 'Token da API'}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="api-token"
                type={showToken ? 'text' : 'password'}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder={isConfigured ? 'Token já salvo' : 'Cole o token aqui'}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={() => setShowToken((value) => !value)}
                aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {isConfigured && (
        <p className="text-xs text-muted-foreground">
          Status: <span className="font-medium text-green-600">Configurado</span>
        </p>
      )}

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
        <Save className="h-4 w-4" /> {saveConfig.isPending ? 'Salvando...' : 'Salvar configuração'}
      </Button>
    </div>
  );

  if (embedded) {
    return formContent;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Phone className="h-5 w-5 text-primary" /> PlugueChat Oficial
        </CardTitle>
        <CardDescription>Configure o número remetente e o token da API oficial do WhatsApp.</CardDescription>
      </CardHeader>
      <CardContent>{formContent}</CardContent>
    </Card>
  );
}
