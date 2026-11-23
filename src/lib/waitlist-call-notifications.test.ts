import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWaitlistCallNotifications, parseWaitlistCallNotifications, retryWaitlistCallNotification } from './waitlist-call-notifications';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke } } }));
const calledAt = '2026-11-22T21:30:00Z';
const snapshot = (overrides: Record<string, unknown> = {}) => ({ company_id: 'company-a', channel: 'evolution', automation_enabled: true, failures: [{ waitlist_id: 'entry-a', called_at: calledAt, can_retry: true }], ...overrides });

beforeEach(() => { vi.clearAllMocks(); invoke.mockResolvedValue({ data: snapshot(), error: null }); });

describe('waitlist call notifications', () => {
  it.each(['evolution', 'pluguechat_official'])('parses only scoped failures from %s', (channel) => {
    expect(parseWaitlistCallNotifications(snapshot({ channel, untrusted_provider_details: 'ignored' }), 'company-a')).toEqual(snapshot({ channel }));
  });

  it('hides all failures when the current automation is disabled', () => {
    expect(parseWaitlistCallNotifications(snapshot({ automation_enabled: false }), 'company-a').failures).toEqual([]);
  });

  it.each([
    snapshot({ company_id: 'other-company' }), snapshot({ channel: 'unknown' }), snapshot({ automation_enabled: undefined }),
    snapshot({ failures: [{ waitlist_id: 'entry-a', called_at: 'invalid', can_retry: true }] }),
    snapshot({ failures: [{ waitlist_id: 'entry-a', called_at: calledAt, can_retry: 'yes' }] }),
    snapshot({ failures: [{ waitlist_id: 'entry-a', called_at: calledAt, can_retry: true }, { waitlist_id: 'entry-a', called_at: calledAt, can_retry: true }] }),
    { success: true }, null,
  ])('rejects an unknown or mismatched response instead of inventing retry permission', (response) => {
    expect(() => parseWaitlistCallNotifications(response, 'company-a')).toThrow('Não foi possível consultar os avisos da chamada.');
  });

  it('loads failures by company without reading or sending contact information', async () => {
    const signal = new AbortController().signal;
    await expect(getWaitlistCallNotifications('company-a', signal)).resolves.toEqual(snapshot());
    expect(invoke).toHaveBeenCalledWith('waitlist-call-notification', { body: { action: 'list', company_id: 'company-a' }, signal });
  });

  it('retries only the original call notice and preserves the expected call timestamp', async () => {
    await expect(retryWaitlistCallNotification('company-a', 'entry-a', calledAt)).resolves.toEqual(snapshot());
    expect(invoke).toHaveBeenCalledWith('waitlist-call-notification', { body: { action: 'retry', company_id: 'company-a', waitlist_id: 'entry-a', expected_called_at: calledAt } });
  });

  it('does not expose provider errors or turn transport failure into a delivery failure', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('provider raw credentials') });
    await expect(getWaitlistCallNotifications('company-a')).rejects.toThrow('Não foi possível consultar os avisos da chamada.');
  });

  it('does not make a request for an invalid retry or an already cancelled read', async () => {
    await expect(retryWaitlistCallNotification('company-a', 'entry-a', 'invalid')).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(getWaitlistCallNotifications('company-a', controller.signal)).rejects.toThrow('Consulta cancelada.');
    expect(invoke).not.toHaveBeenCalled();
  });
});
