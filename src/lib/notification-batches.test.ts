import { describe, expect, it } from 'vitest';
import type { Notification } from '@/hooks/useSettings';
import type { PlatformWhatsAppNotice } from '@/lib/platform-whatsapp-notices';
import { groupPanelNotifications, groupWhatsAppNotices, notificationPreviewText } from './notification-batches';

const base: Notification = {
  id: 'n1',
  company_id: 'a',
  title: 'Atualizações no painel',
  message: '<p>Fizemos melhorias&nbsp;no <strong>menu</strong>.</p><p></p>',
  image_url: null,
  type: 'info',
  is_read: false,
  read_at: null,
  created_by: 'admin',
  created_at: '2026-09-23T15:26:00.123Z',
  recipient_count: 5,
  read_count: 4,
};

describe('notificationPreviewText', () => {
  it('removes tags and entities instead of showing raw HTML', () => {
    expect(notificationPreviewText(base.message)).toBe('Fizemos melhorias no menu.');
    expect(notificationPreviewText('<p>A &amp; B &lt;ok&gt;</p>')).toBe('A & B <ok>');
  });
});

describe('groupPanelNotifications', () => {
  it('turns the rows of one send into a single batch with summed reads', () => {
    const batches = groupPanelNotifications([
      base,
      { ...base, id: 'n2', company_id: 'b', recipient_count: 4, read_count: 4 },
      { ...base, id: 'n3', company_id: 'c', recipient_count: 3, read_count: 0 },
      { ...base, id: 'other', title: 'Outro aviso', created_at: '2026-09-24T10:00:00.000Z' },
    ]);
    expect(batches).toHaveLength(2);
    expect(batches[0].title).toBe('Outro aviso');
    expect(batches[1]).toMatchObject({
      ids: ['n1', 'n2', 'n3'],
      recipientCount: 12,
      readCount: 8,
      companiesWithReads: 2,
    });
  });

  it('keeps sends with the same title at different moments apart', () => {
    const batches = groupPanelNotifications([base, { ...base, id: 'n2', created_at: '2026-09-23T15:26:01.000Z' }]);
    expect(batches).toHaveLength(2);
  });
});

describe('groupWhatsAppNotices', () => {
  const notice = (id: string, status: PlatformWhatsAppNotice['status'], batch = 'batch-1'): PlatformWhatsAppNotice => ({
    id, batch_id: batch, company_id: id, company_name: `Empresa ${id}`, recipient_phone: '+5562999659667',
    image_path: 'notification-images/x.png', caption: 'Aviso', status, attempts: 1, error_message: null,
    created_at: '2026-11-22T16:27:00Z', processed_at: null,
  });

  it('groups by batch and only offers definitive failures and skipped contacts for retry', () => {
    const [batch] = groupWhatsAppNotices([notice('a', 'accepted'), notice('b', 'failed'), notice('c', 'unknown'), notice('d', 'skipped')]);
    expect(batch.rows).toHaveLength(4);
    expect(batch.counts).toMatchObject({ accepted: 1, failed: 1, unknown: 1, skipped: 1 });
    expect(batch.retryable.map((row) => row.id)).toEqual(['b', 'd']);
  });
});
