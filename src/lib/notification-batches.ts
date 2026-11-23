import type { Notification } from '@/hooks/useSettings';
import type { PlatformWhatsAppNotice, PlatformWhatsAppNoticeStatus } from '@/lib/platform-whatsapp-notices';

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

/** Texto limpo para a prévia da lista: sem tags HTML e sem espaços repetidos. */
export function notificationPreviewText(html: string | null | undefined) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|#x27);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PanelNotificationBatch {
  channel: 'panel';
  key: string;
  ids: string[];
  title: string;
  message: string;
  type: string;
  imageUrl: string | null;
  createdAt: string;
  createdBy: string | null;
  rows: Notification[];
  recipientCount: number;
  readCount: number;
  companiesWithReads: number;
}

/**
 * Um envio grava uma linha por empresa num único insert, então todas as
 * linhas do envio têm o mesmo horário de criação, autor, título e texto.
 */
export function panelBatchKey(notification: Notification) {
  return [
    notification.created_by ?? '',
    notification.created_at,
    notification.type,
    notification.title,
    notification.message,
    notification.image_url ?? '',
  ].join('\u0001');
}

export function groupPanelNotifications(notifications: Notification[]): PanelNotificationBatch[] {
  const batches = new Map<string, PanelNotificationBatch>();
  for (const notification of notifications) {
    const key = panelBatchKey(notification);
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        channel: 'panel',
        key,
        ids: [],
        title: notification.title,
        message: notification.message,
        type: notification.type,
        imageUrl: notification.image_url ?? null,
        createdAt: notification.created_at,
        createdBy: notification.created_by ?? null,
        rows: [],
        recipientCount: 0,
        readCount: 0,
        companiesWithReads: 0,
      };
      batches.set(key, batch);
    }
    batch.ids.push(notification.id);
    batch.rows.push(notification);
    batch.recipientCount += notification.recipient_count ?? 0;
    batch.readCount += notification.read_count ?? 0;
    if ((notification.read_count ?? 0) > 0) batch.companiesWithReads += 1;
  }
  return [...batches.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Somente falhas definitivas e contatos pulados podem ser repetidos. */
export const RETRYABLE_NOTICE_STATUSES: PlatformWhatsAppNoticeStatus[] = ['failed', 'skipped'];

export interface WhatsAppNoticeBatch {
  channel: 'whatsapp';
  key: string;
  caption: string;
  imagePath: string;
  createdAt: string;
  rows: PlatformWhatsAppNotice[];
  counts: Record<PlatformWhatsAppNoticeStatus, number>;
  retryable: PlatformWhatsAppNotice[];
}

export function groupWhatsAppNotices(rows: PlatformWhatsAppNotice[]): WhatsAppNoticeBatch[] {
  const batches = new Map<string, WhatsAppNoticeBatch>();
  for (const row of rows) {
    let batch = batches.get(row.batch_id);
    if (!batch) {
      batch = {
        channel: 'whatsapp',
        key: row.batch_id,
        caption: row.caption,
        imagePath: row.image_path,
        createdAt: row.created_at,
        rows: [],
        counts: { queued: 0, processing: 0, accepted: 0, failed: 0, unknown: 0, skipped: 0 },
        retryable: [],
      };
      batches.set(row.batch_id, batch);
    }
    batch.rows.push(row);
    batch.counts[row.status] += 1;
    if (RETRYABLE_NOTICE_STATUSES.includes(row.status)) batch.retryable.push(row);
    if (Date.parse(row.created_at) < Date.parse(batch.createdAt)) batch.createdAt = row.created_at;
  }
  return [...batches.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export type NotificationBatch = PanelNotificationBatch | WhatsAppNoticeBatch;
