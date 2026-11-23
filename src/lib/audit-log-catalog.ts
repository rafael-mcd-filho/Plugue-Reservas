export type AuditCategory = 'empresas' | 'usuarios' | 'financeiro' | 'avisos' | 'configuracoes' | 'suporte';

export const AUDIT_CATEGORIES: Array<{ id: AuditCategory; label: string; dotClassName: string }> = [
  { id: 'empresas', label: 'Empresas', dotClassName: 'bg-info' },
  { id: 'usuarios', label: 'Usuários', dotClassName: 'bg-violet-600' },
  { id: 'financeiro', label: 'Financeiro', dotClassName: 'bg-primary' },
  { id: 'avisos', label: 'Avisos', dotClassName: 'bg-success' },
  { id: 'configuracoes', label: 'Configurações', dotClassName: 'bg-muted-foreground' },
  { id: 'suporte', label: 'Acesso de suporte', dotClassName: 'bg-orange-600' },
];

interface ActionEntry {
  /** Verbo no passado, ex.: "Ativou a cobrança da assinatura". */
  label: string;
  category: AuditCategory;
  /** Complemento usado quando a ação se refere a uma empresa: "de", "para", "em". */
  companyPreposition?: string;
}

/** Catálogo central das ações gravadas em audit_logs. */
export const AUDIT_ACTIONS: Record<string, ActionEntry> = {
  create_company: { label: 'Criou a empresa', category: 'empresas' },
  update_company: { label: 'Atualizou o cadastro', category: 'empresas', companyPreposition: 'de' },
  delete_company: { label: 'Removeu a empresa', category: 'empresas' },
  pause_company: { label: 'Pausou a empresa', category: 'empresas' },
  activate_company: { label: 'Ativou a empresa', category: 'empresas' },
  company_deletion_requested: { label: 'Pediu a exclusão', category: 'empresas', companyPreposition: 'de' },
  company_deletion_teardown_skipped: { label: 'Pulou uma etapa da exclusão', category: 'empresas', companyPreposition: 'de' },

  create_user: { label: 'Criou o usuário', category: 'usuarios' },
  update_user: { label: 'Atualizou o usuário', category: 'usuarios' },
  delete_user: { label: 'Excluiu o usuário', category: 'usuarios' },
  block_user: { label: 'Bloqueou o usuário', category: 'usuarios' },
  unblock_user: { label: 'Desbloqueou o usuário', category: 'usuarios' },
  set_user_password: { label: 'Alterou a senha do usuário', category: 'usuarios' },
  reset_password: { label: 'Redefiniu a senha', category: 'usuarios' },
  update_own_profile: { label: 'Atualizou o próprio perfil', category: 'usuarios' },
  change_own_password: { label: 'Alterou a própria senha', category: 'usuarios' },

  send_notification: { label: 'Enviou um aviso pelo painel', category: 'avisos' },
  delete_notification: { label: 'Retirou um aviso do painel', category: 'avisos' },
  send_whatsapp_notification: { label: 'Enviou um aviso pelo WhatsApp', category: 'avisos' },
  retry_whatsapp_notification: { label: 'Repetiu um aviso pelo WhatsApp', category: 'avisos' },

  set_company_billing_enabled: { label: 'Alterou a cobrança da assinatura', category: 'financeiro', companyPreposition: 'de' },
  set_platform_billing_enabled: { label: 'Alterou a liberação geral da cobrança da assinatura', category: 'financeiro' },
  save_company_billing_link: { label: 'Vinculou o cliente do Asaas', category: 'financeiro', companyPreposition: 'de' },
  remove_company_billing_link: { label: 'Removeu o vínculo com o Asaas', category: 'financeiro', companyPreposition: 'de' },
  sync_company_billing_invoices: { label: 'Sincronizou as faturas', category: 'financeiro', companyPreposition: 'de' },
  sync_all_platform_billing_invoices: { label: 'Sincronizou as faturas de todas as empresas', category: 'financeiro' },
  get_company_billing_invoice_pix_qr_code: { label: 'Gerou o Pix de uma fatura', category: 'financeiro', companyPreposition: 'de' },
  save_terms: { label: 'Alterou as taxas de repasse', category: 'financeiro', companyPreposition: 'de' },
  transition_withdrawal: { label: 'Atualizou um pedido de saque', category: 'financeiro', companyPreposition: 'de' },

  update_settings: { label: 'Atualizou as configurações', category: 'configuracoes' },
  save_platform_billing_token: { label: 'Salvou o token do Asaas das mensalidades', category: 'configuracoes' },
  test_platform_billing_token: { label: 'Testou o token do Asaas das mensalidades', category: 'configuracoes' },
  save_central_reservation_asaas_config: { label: 'Salvou a conta Asaas das reservas', category: 'configuracoes' },

  start_support_impersonation: { label: 'Entrou como suporte no painel', category: 'suporte', companyPreposition: 'de' },
  stop_support_impersonation: { label: 'Saiu do acesso de suporte', category: 'suporte', companyPreposition: 'de' },
  set_support_company_access: { label: 'Alterou as empresas liberadas para o suporte', category: 'suporte' },
  support_api_access: { label: 'Usou uma função como suporte', category: 'suporte', companyPreposition: 'em' },
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  company: 'Empresa',
  company_billing: 'Cobrança da assinatura',
  platform_billing_config: 'Asaas das mensalidades',
  user: 'Usuário',
  notification: 'Aviso do painel',
  platform_whatsapp_notice_batch: 'Aviso por WhatsApp',
  settings: 'Configurações',
  system_settings: 'Configurações',
};

export function actionsForCategory(category: AuditCategory) {
  return Object.entries(AUDIT_ACTIONS)
    .filter(([, entry]) => entry.category === category)
    .map(([action]) => action);
}

/** Ação desconhecida vira texto legível em vez do nome técnico. */
export function humanizeAuditAction(action: string) {
  const known = AUDIT_ACTIONS[action];
  if (known) return known.label;
  const text = action.replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Ação sem nome';
}

export function auditCategoryOf(action: string) {
  const category = AUDIT_ACTIONS[action]?.category;
  return AUDIT_CATEGORIES.find((item) => item.id === category) ?? null;
}

type Details = Record<string, unknown> | null | undefined;

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Empresas citadas no registro, na ordem em que aparecem. */
export function auditCompanyIds(log: { entity_type?: string | null; entity_id?: string | null; details?: Details }) {
  const ids: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value && !ids.includes(value)) ids.push(value);
  };
  if (log.entity_type === 'company' || log.entity_type === 'company_billing') add(log.entity_id);
  add(log.details?.company_id);
  const many = log.details?.company_ids;
  if (Array.isArray(many)) many.forEach(add);
  return ids;
}

/**
 * Frase do acontecimento, ex.: "Ativou a cobrança da assinatura de Space Pizza".
 * Os nomes das empresas vêm do cadastro atual quando o registro só guarda o ID.
 */
function describeAuditLogBase(
  log: { action: string; entity_type?: string | null; entity_id?: string | null; details?: Details },
  companyName: (id: string) => string | null,
) {
  const details = log.details ?? {};
  const entry = AUDIT_ACTIONS[log.action];
  let sentence = humanizeAuditAction(log.action);

  if (log.action === 'set_company_billing_enabled') {
    const enabled = typeof details.billing_enabled === 'boolean'
      ? details.billing_enabled
      : typeof details.requested_enabled === 'boolean'
        ? details.requested_enabled
        : typeof details.enabled === 'boolean' ? details.enabled : null;
    if (enabled !== null) {
      sentence = details.success === false
        ? `Tentou ${enabled ? 'ativar' : 'desligar'} a cobrança da assinatura`
        : enabled ? 'Ativou a cobrança da assinatura' : 'Desligou a cobrança da assinatura';
    }
  }
  if (log.action === 'set_platform_billing_enabled' && typeof details.enabled === 'boolean') {
    sentence = details.enabled ? 'Liberou a cobrança da assinatura para as empresas' : 'Desligou a cobrança da assinatura para todas as empresas';
  }

  const target = text(details.target_name) ?? text(details.target_email);
  if (target && entry?.category === 'usuarios' && !log.action.includes('own')) {
    return `${sentence} ${target}`;
  }

  const title = text(details.title);
  const companyIds = auditCompanyIds(log);
  const count = typeof details.company_count === 'number' ? details.company_count : companyIds.length;
  if (entry?.category === 'avisos') {
    const subject = title ? ` “${title}”` : '';
    if (count > 1) return `${sentence}${subject} para ${count} empresas`;
    const name = companyIds[0] ? companyName(companyIds[0]) : null;
    return name ? `${sentence}${subject} ${log.action.startsWith('delete') ? 'de' : 'para'} ${name}` : `${sentence}${subject}`;
  }

  const name = companyIds.length === 1 ? companyName(companyIds[0]) ?? text(details.company_name) ?? text(details.name) : text(details.company_name);
  if (name) {
    if (entry?.companyPreposition) return `${sentence} ${entry.companyPreposition} ${name}`;
    return `${sentence} ${name}`;
  }
  if (log.action === 'create_company' && text(details.name)) return `${sentence} ${text(details.name)}`;
  if (count > 1) return `${sentence} (${count} empresas)`;
  const key = text(details.key);
  if (key) return `${sentence}: ${key}`;
  return sentence;
}

const DETAIL_LABELS: Record<string, string> = {
  title: 'Título',
  type: 'Tipo',
  enabled: 'Ativado',
  environment: 'Ambiente',
  role: 'Perfil',
  status: 'Situação',
  target_name: 'Pessoa',
  target_email: 'E-mail',
  email_changed: 'E-mail alterado',
  company_count: 'Empresas',
  processed_count: 'Processadas',
  success_count: 'Com sucesso',
  failed_count: 'Com erro',
  key: 'Configuração',
  reason: 'Motivo',
};

/** Campos legíveis do registro para o painel de detalhes, sem IDs técnicos. */
export function readableAuditDetails(details: Details) {
  if (!details) return [] as Array<{ label: string; value: string }>;
  return Object.entries(details)
    .filter(([key, value]) => DETAIL_LABELS[key] && value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({
      label: DETAIL_LABELS[key],
      value: typeof value === 'boolean'
        ? (value ? 'Sim' : 'Não')
        : key === 'environment'
          ? (value === 'production' ? 'Produção' : value === 'sandbox' ? 'Sandbox' : String(value))
          : String(value),
    }));
}

/**
 * Frase do acontecimento, ex.: "Ativou a cobrança da assinatura de Space Pizza".
 * Um registro com success: false ganha a indicação de que não foi concluído.
 */
export function describeAuditLog(
  log: { action: string; entity_type?: string | null; entity_id?: string | null; details?: Details },
  companyName: (id: string) => string | null,
) {
  const sentence = describeAuditLogBase(log, companyName);
  const failed = log.details?.success === false && !sentence.startsWith('Tentou');
  return failed ? `${sentence} (não concluído)` : sentence;
}
