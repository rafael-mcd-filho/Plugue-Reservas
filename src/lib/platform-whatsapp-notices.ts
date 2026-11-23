import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import { normalizeStoredPhoneE164 } from '@/lib/phone';

export const NOTICE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const NOTICE_CAPTION_MAX_LENGTH = 1000;
export const NOTICE_INSTANCE_NAME = 'RWSL' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_PATH = /^notification-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|jpeg)$/i;
const STATUSES = ['queued', 'processing', 'accepted', 'failed', 'unknown', 'skipped'] as const;
export type PlatformWhatsAppNoticeStatus = typeof STATUSES[number];

export interface PlatformWhatsAppNotice {
  id: string;
  batch_id: string;
  company_id: string | null;
  company_name: string;
  recipient_phone: string | null;
  image_path: string;
  caption: string;
  status: PlatformWhatsAppNoticeStatus;
  attempts: number;
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface NoticeResult {
  rows: PlatformWhatsAppNotice[];
  total: number;
  instance_name: typeof NOTICE_INSTANCE_NAME;
  contact_kind: 'responsible';
}

export interface CreatePlatformWhatsAppNoticeInput {
  request_id: string;
  company_ids: string[];
  image_path: string;
  caption: string;
}

export interface CompanyNoticeContact {
  responsible_phone?: string | null;
  responsible_phone_e164?: string | null;
  responsible_phone_country?: string | null;
}

/** Never redirect an administrative notice to the public or primary number. */
export function getCompanyNoticeContact(company: CompanyNoticeContact): { phone: string | null; reason: string | null } {
  const raw = company.responsible_phone_e164?.trim() || company.responsible_phone?.trim();
  if (!raw) return { phone: null, reason: 'Telefone do responsável não cadastrado.' };
  const phone = normalizeStoredPhoneE164(raw, company.responsible_phone_country?.trim().toUpperCase() || 'BR');
  return phone ? { phone, reason: null } : { phone: null, reason: 'Telefone do responsável inválido.' };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validTimestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const responseError = () => new Error('Não foi possível conferir o resultado dos avisos de WhatsApp. Atualize o histórico antes de reenviar.');

/** An unknown provider result must not be presented as a successful send. */
export function parseNoticeResult(value: unknown): NoticeResult {
  if (!isRecord(value) || value.instance_name !== NOTICE_INSTANCE_NAME || value.contact_kind !== 'responsible'
    || !Array.isArray(value.rows) || !Number.isSafeInteger(value.total) || (value.total as number) < value.rows.length) throw responseError();
  const seen = new Set<string>();
  const rows = value.rows.map((row): PlatformWhatsAppNotice => {
    if (!isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id) || seen.has(row.id)
      || typeof row.batch_id !== 'string' || !UUID.test(row.batch_id)
      || !(row.company_id === null || (typeof row.company_id === 'string' && UUID.test(row.company_id)))
      || typeof row.company_name !== 'string' || !row.company_name.trim()
      || !(row.recipient_phone === null || (typeof row.recipient_phone === 'string' && /^\+[1-9]\d{6,14}$/.test(row.recipient_phone)))
      || typeof row.image_path !== 'string' || !IMAGE_PATH.test(row.image_path)
      || typeof row.caption !== 'string' || !row.caption.trim() || row.caption.length > NOTICE_CAPTION_MAX_LENGTH
      || !STATUSES.includes(row.status as PlatformWhatsAppNoticeStatus)
      || !Number.isSafeInteger(row.attempts) || (row.attempts as number) < 0
      || !(row.error_message === null || typeof row.error_message === 'string')
      || !validTimestamp(row.created_at) || !(row.processed_at === null || validTimestamp(row.processed_at))) throw responseError();
    seen.add(row.id);
    return {
      id: row.id, batch_id: row.batch_id, company_id: row.company_id as string | null,
      company_name: row.company_name, recipient_phone: row.recipient_phone as string | null,
      image_path: row.image_path, caption: row.caption, status: row.status as PlatformWhatsAppNoticeStatus,
      attempts: row.attempts as number, error_message: row.error_message as string | null,
      created_at: row.created_at, processed_at: row.processed_at as string | null,
    };
  });
  return { rows, total: value.total as number, instance_name: NOTICE_INSTANCE_NAME, contact_kind: 'responsible' };
}

async function requestNotice(body: Record<string, unknown>, signal?: AbortSignal): Promise<NoticeResult> {
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  const { data, error } = await supabase.functions.invoke<unknown>('platform-whatsapp-notices', {
    body, ...(signal ? { signal } : {}),
  });
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  if (error) throw new Error(await getFunctionErrorMessage(error));
  if (isRecord(data) && typeof data.error === 'string') throw new Error(data.error);
  return parseNoticeResult(data);
}

export function fetchPlatformWhatsAppNotices({ offset = 0, limit = 25 }: { offset?: number; limit?: number } = {}, signal?: AbortSignal) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return Promise.reject(new Error('Página de avisos inválida.'));
  }
  return requestNotice({ action: 'list', offset, limit }, signal);
}

export function createPlatformWhatsAppNotice(input: CreatePlatformWhatsAppNoticeInput) {
  const companyIds = Array.isArray(input.company_ids)
    ? [...new Set(input.company_ids.map(id => typeof id === 'string' ? id.toLowerCase() : id))].sort()
    : [];
  const caption = typeof input.caption === 'string' ? input.caption.trim() : '';
  if (typeof input.request_id !== 'string' || !UUID.test(input.request_id)) return Promise.reject(new Error('Identificação do envio inválida.'));
  if (!companyIds.length || companyIds.length > 1000 || companyIds.some(id => typeof id !== 'string' || !UUID.test(id))) return Promise.reject(new Error('Selecione entre uma e mil empresas válidas.'));
  if (typeof input.image_path !== 'string' || !IMAGE_PATH.test(input.image_path)) return Promise.reject(new Error('Selecione uma imagem PNG ou JPG para o aviso.'));
  if (!caption || caption.length > NOTICE_CAPTION_MAX_LENGTH) return Promise.reject(new Error('Escreva uma legenda de até 1.000 caracteres.'));
  return requestNotice({ action: 'create', request_id: input.request_id, company_ids: companyIds, image_path: input.image_path, caption });
}

export function retryPlatformWhatsAppNotice({ notice_id }: { notice_id: string }) {
  if (typeof notice_id !== 'string' || !UUID.test(notice_id)) return Promise.reject(new Error('Aviso não identificado.'));
  return requestNotice({ action: 'retry', notice_id });
}

async function readHeader(file: File): Promise<Uint8Array> {
  const slice = file.slice(0, 12);
  if (typeof slice.arrayBuffer === 'function') return new Uint8Array(await slice.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(new Uint8Array(reader.result)) : reject(new Error('Não foi possível ler a imagem.'));
    reader.readAsArrayBuffer(slice);
  });
}

export async function validateNoticeImage(file: File): Promise<void> {
  const mime = file.type.toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/jpg'].includes(mime)) throw new Error('Escolha uma imagem PNG ou JPG.');
  if (file.size === 0 || file.size > NOTICE_IMAGE_MAX_BYTES) throw new Error('A imagem deve ter até 5 MB e não pode estar vazia.');
  const header = await readHeader(file);
  const isPng = header.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const isJpeg = header.length >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255;
  if ((mime === 'image/png' && !isPng) || (mime !== 'image/png' && !isJpeg)) throw new Error('O conteúdo do arquivo não corresponde a uma imagem PNG ou JPG.');
}

export function noticeImageUrl(path: string): string {
  if (!IMAGE_PATH.test(path)) throw new Error('Imagem do aviso inválida.');
  const { data } = supabase.storage.from('system-assets').getPublicUrl(path);
  if (!data.publicUrl) throw new Error('Não foi possível carregar a imagem do aviso.');
  return data.publicUrl;
}

export async function uploadNoticeImage(file: File): Promise<{ path: string; url: string }> {
  await validateNoticeImage(file);
  const isPng = file.type.toLowerCase() === 'image/png';
  const path = `notification-images/${crypto.randomUUID()}.${isPng ? 'png' : 'jpg'}`;
  const { error } = await supabase.storage.from('system-assets').upload(path, file, {
    upsert: false, contentType: isPng ? 'image/png' : 'image/jpeg',
  });
  if (error) throw new Error(error.message || 'Não foi possível enviar a imagem.');
  return { path, url: noticeImageUrl(path) };
}
