import { useMemo, useState } from 'react';
import { Bot, History, Radio, Send } from 'lucide-react';
import PlugueChatMessageHistory from './PlugueChatMessageHistory';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import BroadcastsTab from './BroadcastsTab';
import ChannelTab from './ChannelTab';
import PlugueChatBroadcastsTab from './PlugueChatBroadcastsTab';
import PlugueChatMessages from './PlugueChatMessages';
import WhatsAppMessageHistory from './WhatsAppMessageHistory';
import { type AutomationSetting, useAutomationSettings, useUpsertAutomation } from '@/hooks/useAutomations';
import { useAutomationDrafts } from '@/hooks/useAutomationDrafts';
import { useUnsavedChangesWarning } from '@/hooks/useUnsavedChangesWarning';
import { useWhatsAppChannel } from '@/hooks/useWhatsAppChannel';
import { WHATSAPP_AUTOMATIONS } from '@/lib/whatsapp-automations';
import { useCompanyNpsActivation } from '@/hooks/useCompanyNpsActivation';
import AutomationJourneyEditor from './AutomationJourneyEditor';

interface Props { companyId: string; saveBlocked?: boolean }
type AutomationLocalState = Record<string, { enabled: boolean; message_template: string }>;
type AutomationTab = 'channel' | 'messages' | 'broadcast' | 'history';
const automationTabTriggerClass = 'min-h-[36px] shrink-0 gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none';
const tabStorageKey = (companyId: string) => `automations:tab:${companyId}`;

function readRememberedTab(companyId: string): AutomationTab {
  try {
    const value = sessionStorage.getItem(tabStorageKey(companyId));
    if (value === 'messages' || value === 'broadcast' || value === 'history') return value;
  } catch { /* Browser storage is optional. */ }
  return 'channel';
}

function buildAutomationState(automations: AutomationSetting[] | undefined): AutomationLocalState {
  return Object.fromEntries(WHATSAPP_AUTOMATIONS.map((automation) => {
    const existing = automations?.find((item) => item.type === automation.type);
    return [automation.type, { enabled: existing?.enabled ?? false, message_template: existing?.message_template ?? automation.defaultTemplate }];
  }));
}

export default function AutomationsTab({ companyId, saveBlocked = false }: Props) {
  return <CompanyAutomationsEditor key={companyId} companyId={companyId} saveBlocked={saveBlocked} />;
}

function CompanyAutomationsEditor({ companyId, saveBlocked }: Props) {
  const { data: channel, isLoading: channelLoading, isError: channelError, refetch: refetchChannel } = useWhatsAppChannel(companyId);
  const isPlugueChat = channel === 'pluguechat_official';
  const { data: npsConfig, isPending: npsLoading, isError: npsError } = useCompanyNpsActivation(companyId);
  const reviewsAvailable = !npsLoading && !npsError && npsConfig?.enabled === true;
  const { data: automations, isLoading: automationsLoading, isError: automationsError, refetch: refetchAutomations } = useAutomationSettings(companyId);
  const upsertAutomation = useUpsertAutomation();
  const serverState = useMemo(() => buildAutomationState(automations), [automations]);
  const drafts = useAutomationDrafts(companyId, serverState, !automationsLoading && !automationsError && automations !== undefined);
  const [tab, setTab] = useState<AutomationTab>(() => readRememberedTab(companyId));
  const [messagesVisited, setMessagesVisited] = useState(tab === 'messages');
  const [officialDirty, setOfficialDirty] = useState(false);
  const [savingType, setSavingType] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, boolean>>({});
  const saving = upsertAutomation.isPending || savingType !== null;
  useUnsavedChangesWarning(drafts.hasUnsavedChanges || officialDirty);

  const handleTabChange = (value: string) => {
    const next = value as AutomationTab;
    setTab(next);
    if (next === 'messages') setMessagesVisited(true);
    try { sessionStorage.setItem(tabStorageKey(companyId), next); } catch { /* Browser storage is optional. */ }
  };

  const handleSave = async (type: string) => {
    const state = drafts.states[type];
    if (!state || saving || automationsError || channelError || saveBlocked || !drafts.isDirty(type)) return;
    setSavingType(type);
    setSaveErrors((previous) => ({ ...previous, [type]: false }));
    try {
      await upsertAutomation.mutateAsync({ company_id: companyId, type, enabled: state.enabled, message_template: state.message_template });
      drafts.commit(type, state);
    } catch {
      setSaveErrors((previous) => ({ ...previous, [type]: true }));
    } finally { setSavingType(null); }
  };

  if (channelError && !channel) {
    return <div role="alert" className="space-y-3 text-sm">
      <p>Não foi possível carregar o canal de WhatsApp.</p>
      <Button variant="outline" size="sm" onClick={() => void refetchChannel()}>Tentar novamente</Button>
    </div>;
  }
  if (channelLoading || !channel) {
    return <div className="space-y-6" aria-busy="true" aria-label="Carregando canal de WhatsApp">
      <Skeleton className="h-10 w-full" /><Skeleton className="h-48 w-full" />
    </div>;
  }

  return <Tabs value={tab} onValueChange={handleTabChange} className="space-y-6">
    <div className="overflow-x-auto pb-1">
      <TabsList className="h-auto w-max min-w-full justify-start rounded-xl border border-[rgba(0,0,0,0.08)] bg-white p-1 md:min-w-0">
        <TabsTrigger value="channel" className={automationTabTriggerClass}><Radio className="h-4 w-4" /> Canal</TabsTrigger>
        <TabsTrigger value="messages" className={automationTabTriggerClass}><Bot className="h-4 w-4" /> Automações</TabsTrigger>
        <TabsTrigger value="broadcast" className={automationTabTriggerClass}><Send className="h-4 w-4" /> Disparo</TabsTrigger>
        <TabsTrigger value="history" className={automationTabTriggerClass}><History className="h-4 w-4" /> Histórico</TabsTrigger>
      </TabsList>
    </div>
    {channelError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p>Não foi possível atualizar o canal. Tente novamente antes de salvar.</p>
      <Button variant="outline" size="sm" onClick={() => void refetchChannel()}>Tentar novamente</Button>
    </div>}
    <TabsContent value="channel"><ChannelTab companyId={companyId} activeChannel={channel} /></TabsContent>
    {messagesVisited && <TabsContent value="messages" forceMount hidden={tab !== 'messages'} className="space-y-4 data-[state=inactive]:hidden">
      <div hidden={!isPlugueChat}><PlugueChatMessages companyId={companyId} activeChannel={channel} saveBlocked={channelError || saveBlocked} onUnsavedChange={setOfficialDirty} /></div>
      <div hidden={isPlugueChat} className="space-y-4">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold"><Bot className="h-5 w-5 text-primary" /> Mensagens automáticas</h3>
          <p className="text-sm text-muted-foreground">Ligar, desligar e o texto são salvos juntos, no botão Salvar de cada mensagem.</p>
        </div>
        {automationsError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <p>Não foi possível carregar as automações. Suas edições foram mantidas; tente novamente antes de salvar.</p>
          <Button variant="outline" size="sm" onClick={() => void refetchAutomations()}>Tentar novamente</Button>
        </div>}
        {automationsLoading || (!drafts.ready && !automationsError) ? <Skeleton className="h-48 w-full" /> : drafts.ready && <AutomationJourneyEditor
          states={drafts.states}
          isDirty={drafts.isDirty}
          onChange={drafts.update}
          onDiscard={(type) => { drafts.discard(type); setSaveErrors((previous) => ({ ...previous, [type]: false })); }}
          onSave={(type) => void handleSave(type)}
          saving={saving}
          savingType={savingType}
          saveErrors={saveErrors}
          saveDisabled={automationsError || channelError || saveBlocked}
          reviewsAvailable={reviewsAvailable}
          npsLoading={npsLoading}
          npsError={npsError}
        />}
      </div>
    </TabsContent>}
    <TabsContent value="broadcast">{isPlugueChat ? <PlugueChatBroadcastsTab companyId={companyId} activeChannel={channel} /> : <BroadcastsTab companyId={companyId} />}</TabsContent>
    <TabsContent value="history">{isPlugueChat ? <PlugueChatMessageHistory companyId={companyId} /> : <WhatsAppMessageHistory companyId={companyId} />}</TabsContent>
  </Tabs>;
}
