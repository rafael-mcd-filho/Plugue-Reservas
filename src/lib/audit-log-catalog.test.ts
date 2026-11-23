import { describe, expect, it } from 'vitest';
import { auditCategoryOf, auditCompanyIds, describeAuditLog, humanizeAuditAction } from './audit-log-catalog';

const names: Record<string, string> = { 'company-1': 'Space Pizza', 'company-2': 'Beco Mágico - Recife' };
const companyName = (id: string) => names[id] ?? null;

describe('audit log catalog', () => {
  it('translates the financial and support actions that used to appear as technical names', () => {
    expect(humanizeAuditAction('sync_all_platform_billing_invoices')).toBe('Sincronizou as faturas de todas as empresas');
    expect(auditCategoryOf('start_support_impersonation')?.label).toBe('Acesso de suporte');
    expect(humanizeAuditAction('some_new_action')).toBe('Some new action');
  });

  it('describes the event as a sentence with the company name instead of its ID', () => {
    expect(describeAuditLog({
      action: 'set_company_billing_enabled',
      details: { company_id: 'company-1', enabled: true },
    }, companyName)).toBe('Ativou a cobrança da assinatura de Space Pizza');
    expect(describeAuditLog({
      action: 'set_company_billing_enabled',
      entity_type: 'company_billing',
      entity_id: 'company-2',
      details: { success: true, billing_enabled: false },
    }, companyName)).toBe('Desligou a cobrança da assinatura de Beco Mágico - Recife');
    expect(describeAuditLog({
      action: 'save_company_billing_link',
      entity_type: 'company_billing',
      entity_id: 'company-1',
      details: { success: false },
    }, companyName)).toBe('Vinculou o cliente do Asaas de Space Pizza (não concluído)');
    expect(describeAuditLog({
      action: 'send_notification',
      details: { title: 'Novidade', company_count: 2, company_ids: ['company-1', 'company-2'] },
    }, companyName)).toBe('Enviou um aviso pelo painel “Novidade” para 2 empresas');
    expect(describeAuditLog({
      action: 'update_user',
      details: { target_name: 'Marina Alves' },
    }, companyName)).toBe('Atualizou o usuário Marina Alves');
  });

  it('collects the companies mentioned by the entity and the details', () => {
    expect(auditCompanyIds({ entity_type: 'company', entity_id: 'company-1', details: { company_ids: ['company-1', 'company-2'] } }))
      .toEqual(['company-1', 'company-2']);
  });
});
