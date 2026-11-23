import type { AuditLog } from '@/hooks/useSettings';
import type { ManagedUser } from '@/hooks/useUsers';
import { auditCategoryOf, describeAuditLog } from '@/lib/audit-log-catalog';
import type { CompanyAccessEvent } from './useCompanyDetailData';

export type HistoryKind = 'acesso' | 'alteracao';

export interface CompanyHistoryItem {
  id: string;
  kind: HistoryKind;
  createdAt: string;
  text: string;
  tag: string;
  tagTone: 'plain' | 'support' | 'info' | 'brand' | 'success';
}

const CATEGORY_TONE: Record<string, CompanyHistoryItem['tagTone']> = {
  empresas: 'info',
  usuarios: 'info',
  financeiro: 'brand',
  avisos: 'success',
  configuracoes: 'plain',
  suporte: 'support',
};

/** Junta acessos ao painel e ações da auditoria numa linha do tempo só. */
export function buildCompanyHistory(
  access: CompanyAccessEvent[],
  audit: AuditLog[],
  users: ManagedUser[],
  companyName: (id: string) => string | null,
): CompanyHistoryItem[] {
  const nameOf = (id: string | null) => {
    if (!id) return 'Alguém';
    const user = users.find((item) => item.id === id);
    return user?.full_name || user?.email || 'Usuário removido';
  };
  const accessItems = access.map((event): CompanyHistoryItem => {
    const metadata = event.metadata ?? {};
    const asSupport = metadata.impersonated_by_support === true;
    const actor = nameOf(event.user_id);
    return {
      id: `access-${event.id}`,
      kind: 'acesso',
      createdAt: event.created_at,
      text: event.event_type === 'login'
        ? `${actor} entrou no sistema`
        : asSupport ? `${actor} acessou o painel como suporte` : `${actor} acessou o painel`,
      tag: asSupport ? 'Acesso de suporte' : 'Acesso',
      tagTone: asSupport ? 'support' : 'plain',
    };
  });
  const auditItems = audit.map((log): CompanyHistoryItem => {
    const category = auditCategoryOf(log.action);
    const actor = log.actor_name || log.actor_email || 'Alguém';
    const sentence = describeAuditLog(log, companyName);
    return {
      id: `audit-${log.id}`,
      kind: 'alteracao',
      createdAt: log.created_at,
      text: `${actor}: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`,
      tag: category?.label ?? 'Outras',
      tagTone: category ? CATEGORY_TONE[category.id] ?? 'plain' : 'plain',
    };
  });
  const sorted = [...accessItems, ...auditItems].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return groupAccessSessions(sorted);
}

const SESSION_GAP_MS = 60 * 60 * 1000;

function timeOf(value: string) {
  return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Cada página aberta grava um acesso. Os acessos da mesma pessoa, com menos de
 * uma hora entre eles, viram uma linha só (uma sessão), mesmo que outra pessoa
 * tenha usado o painel no mesmo período.
 */
function groupAccessSessions(items: CompanyHistoryItem[]) {
  type Session = { item: CompanyHistoryItem; count: number; earliest: string };
  const output: Array<CompanyHistoryItem | Session> = [];
  const openSessions = new Map<string, Session>();
  for (const item of items) {
    if (item.kind !== 'acesso') {
      output.push(item);
      continue;
    }
    const open = openSessions.get(item.text);
    if (open && Date.parse(open.earliest) - Date.parse(item.createdAt) <= SESSION_GAP_MS) {
      open.count += 1;
      open.earliest = item.createdAt;
      continue;
    }
    const session: Session = { item, count: 1, earliest: item.createdAt };
    openSessions.set(item.text, session);
    output.push(session);
  }
  return output.map((entry) => {
    if (!('count' in entry)) return entry;
    if (entry.count === 1) return entry.item;
    const first = timeOf(entry.earliest);
    const last = timeOf(entry.item.createdAt);
    const range = first === last ? `às ${last}` : `entre ${first} e ${last}`;
    return { ...entry.item, text: `${entry.item.text} · ${entry.count} vezes ${range}` };
  });
}
