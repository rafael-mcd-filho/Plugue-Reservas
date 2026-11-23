import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformWhatsAppNotice, fetchPlatformWhatsAppNotices, getCompanyNoticeContact,
  NOTICE_IMAGE_MAX_BYTES, noticeImageUrl, parseNoticeResult, retryPlatformWhatsAppNotice,
  uploadNoticeImage, validateNoticeImage,
} from './platform-whatsapp-notices';

const mock = vi.hoisted(() => ({ invoke: vi.fn(), upload: vi.fn(), storage: vi.fn(), url: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  functions: { invoke: mock.invoke }, storage: { from: mock.storage },
} }));
vi.mock('@/lib/functionErrors', () => ({ getFunctionErrorMessage: async (error: { message?: string }) => error.message ?? 'Erro da função.' }));

const noticeId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const companyId = '33333333-3333-4333-8333-333333333333';
const imagePath = `notification-images/${noticeId}.png`;
const row = {
  id: noticeId, batch_id: requestId, company_id: companyId, company_name: 'Empresa de teste',
  recipient_phone: '+5511999991111', image_path: imagePath, caption: 'Um aviso\nCom duas linhas.',
  status: 'queued', attempts: 0, error_message: null, created_at: '2026-11-22T16:00:00Z', processed_at: null,
};
const result = (patch: Record<string, unknown> = {}) => ({ rows: [{ ...row }], total: 1, instance_name: 'RWSL', contact_kind: 'responsible', ...patch });
const input = () => ({ request_id: requestId, company_ids: [companyId], image_path: imagePath, caption: 'Legenda' });
const png = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'imagem.png', { type: 'image/png' });
const jpeg = () => new File([new Uint8Array([255, 216, 255, 224, 0, 16])], 'imagem.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  vi.clearAllMocks();
  mock.invoke.mockResolvedValue({ data: result(), error: null });
  mock.upload.mockResolvedValue({ error: null });
  mock.url.mockImplementation((path: string) => ({ data: { publicUrl: `https://storage.example.test/${path}` } }));
  mock.storage.mockReturnValue({ upload: mock.upload, getPublicUrl: mock.url });
});

describe('responsible contact for platform notices', () => {
  it('uses only the responsible contact and preserves international destinations', () => {
    expect(getCompanyNoticeContact({ responsible_phone: '(11) 99999-1111' })).toEqual({ phone: '+5511999991111', reason: null });
    expect(getCompanyNoticeContact({ responsible_phone: '(407) 264-1934', responsible_phone_country: 'US' })).toEqual({ phone: '+14072641934', reason: null });
    expect(getCompanyNoticeContact({ responsible_phone_e164: '+14072641934', responsible_phone: '(11) 99999-1111' }).phone).toBe('+14072641934');
  });
  it('never falls back to another contact or conceals a broken canonical number', () => {
    expect(getCompanyNoticeContact({ responsible_phone_e164: 'invalid', responsible_phone: '(11) 99999-1111' })).toEqual({ phone: null, reason: 'Telefone do responsável inválido.' });
    const company = { phone: '+5511999991111', whatsapp: '+5511988882222' };
    expect(getCompanyNoticeContact(company as never)).toEqual({ phone: null, reason: 'Telefone do responsável não cadastrado.' });
  });
});

describe('notice result boundary', () => {
  it('accepts every explicit delivery state without changing accepted into delivered or read', () => {
    for (const status of ['queued', 'processing', 'accepted', 'failed', 'unknown', 'skipped']) {
      const parsed = parseNoticeResult(result({ rows: [{ ...row, status, api_token: 'must-not-leak' }] }));
      expect(parsed.rows[0].status).toBe(status);
      expect(parsed.rows[0]).not.toHaveProperty('api_token');
    }
  });
  it('accepts skipped/missing contact and deleted company snapshots', () => {
    expect(parseNoticeResult(result({ rows: [{ ...row, company_id: null, recipient_phone: null, status: 'skipped', error_message: 'Contato ausente.' }] })).rows[0]).toMatchObject({ company_name: 'Empresa de teste', recipient_phone: null, status: 'skipped' });
  });
  it.each([
    { instance_name: 'company-instance' }, { contact_kind: 'primary' }, { total: 0 }, { total: -1 },
    { rows: [{ ...row, status: 'delivered' }] }, { rows: [{ ...row, attempts: -1 }] },
    { rows: [{ ...row, image_path: '../outside.png' }] }, { rows: [{ ...row, created_at: 'broken' }] },
    { rows: [{ ...row, recipient_phone: 'invalid' }] }, { rows: [row, row], total: 2 },
  ])('rejects unsafe, incomplete or contradictory responses %j', patch => {
    expect(() => parseNoticeResult(result(patch))).toThrow(/Atualize o histórico/);
  });
});

describe('notice request boundary', () => {
  it('deduplicates company IDs, trims plain caption and preserves the caller idempotency key', async () => {
    await createPlatformWhatsAppNotice({ ...input(), company_ids: [companyId, companyId], caption: '  Texto simples\nMais uma linha.  ' });
    expect(mock.invoke).toHaveBeenCalledWith('platform-whatsapp-notices', { body: {
      action: 'create', request_id: requestId, company_ids: [companyId], image_path: imagePath, caption: 'Texto simples\nMais uma linha.',
    } });
    await createPlatformWhatsAppNotice(input());
    expect(mock.invoke.mock.calls[1][1].body.request_id).toBe(requestId);
  });
  it('rejects invalid inputs before requesting an external function', async () => {
    for (const patch of [
      { request_id: '' }, { company_ids: [] }, { company_ids: ['invalid'] },
      { image_path: 'https://external.example.test/image.png' }, { image_path: 'notification-images/../image.png' },
      { caption: '   ' }, { caption: 'x'.repeat(1001) },
    ]) await expect(createPlatformWhatsAppNotice({ ...input(), ...patch })).rejects.toThrow();
    expect(mock.invoke).not.toHaveBeenCalled();
  });
  it('normalizes UUID case before deduplicating recipients', async () => {
    const company = 'abcdefab-1111-4111-8111-abcdefabcdef';
    await createPlatformWhatsAppNotice({ ...input(), company_ids: [company.toUpperCase(), company] });
    expect(mock.invoke.mock.calls[0][1].body.company_ids).toEqual([company]);
  });
  it('paginates the history and sends only the notice ID to retry', async () => {
    await fetchPlatformWhatsAppNotices({ offset: 25, limit: 25 });
    expect(mock.invoke.mock.calls[0][1].body).toEqual({ action: 'list', offset: 25, limit: 25 });
    await retryPlatformWhatsAppNotice({ notice_id: noticeId });
    expect(mock.invoke.mock.calls[1][1].body).toEqual({ action: 'retry', notice_id: noticeId });
    await expect(fetchPlatformWhatsAppNotices({ limit: 101 })).rejects.toThrow('Página de avisos inválida.');
    await expect(retryPlatformWhatsAppNotice({ notice_id: '' })).rejects.toThrow('Aviso não identificado.');
  });
  it('keeps request errors distinct from a successful empty history', async () => {
    mock.invoke.mockResolvedValueOnce({ data: null, error: { message: 'Não autorizado' } });
    await expect(fetchPlatformWhatsAppNotices()).rejects.toThrow('Não autorizado');
    mock.invoke.mockResolvedValueOnce({ data: { error: 'Imagem indisponível.' }, error: null });
    await expect(createPlatformWhatsAppNotice(input())).rejects.toThrow('Imagem indisponível.');
    mock.invoke.mockResolvedValueOnce({ data: result({ rows: [], total: 0 }), error: null });
    await expect(fetchPlatformWhatsAppNotices()).resolves.toMatchObject({ rows: [], total: 0 });
  });
  it('does not request or expose an obsolete result after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchPlatformWhatsAppNotices({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.invoke).not.toHaveBeenCalled();
    const later = new AbortController();
    mock.invoke.mockImplementationOnce(async () => { later.abort(); return { data: result(), error: null }; });
    await expect(fetchPlatformWhatsAppNotices({}, later.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('notice image upload', () => {
  it('accepts PNG and JPEG actual bytes and uploads only to the owned notification prefix', async () => {
    await expect(validateNoticeImage(png())).resolves.toBeUndefined();
    await expect(validateNoticeImage(jpeg())).resolves.toBeUndefined();
    const file = png();
    const uploaded = await uploadNoticeImage(file);
    expect(uploaded.path).toMatch(/^notification-images\/[0-9a-f-]{36}\.png$/);
    expect(uploaded.url).toBe(`https://storage.example.test/${uploaded.path}`);
    expect(mock.storage).toHaveBeenCalledWith('system-assets');
    expect(mock.upload).toHaveBeenCalledWith(uploaded.path, file, { upsert: false, contentType: 'image/png' });
  });
  it('rejects unsupported, disguised, empty and oversized files without uploading them', async () => {
    const large = png(); Object.defineProperty(large, 'size', { value: NOTICE_IMAGE_MAX_BYTES + 1 });
    for (const file of [
      new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }),
      new File(['%PDF'], 'disguised.png', { type: 'image/png' }),
      new File([], 'empty.jpg', { type: 'image/jpeg' }), large,
    ]) await expect(uploadNoticeImage(file)).rejects.toThrow();
    expect(mock.upload).not.toHaveBeenCalled();
  });
  it('preserves upload errors and never derives a URL for an arbitrary path', async () => {
    mock.upload.mockResolvedValueOnce({ error: { message: 'Sem permissão no armazenamento.' } });
    await expect(uploadNoticeImage(png())).rejects.toThrow('Sem permissão no armazenamento.');
    expect(() => noticeImageUrl('https://outside.example.test/image.jpg')).toThrow('Imagem do aviso inválida.');
  });
});
