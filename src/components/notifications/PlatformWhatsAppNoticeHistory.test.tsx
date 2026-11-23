import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlatformWhatsAppNoticeHistory from './PlatformWhatsAppNoticeHistory';
import type { PlatformWhatsAppNotice } from '@/lib/platform-whatsapp-notices';
const mock = vi.hoisted(() => ({ query: { data: undefined as any, isPending: false, isError: false, isFetching: false, refetch: vi.fn() }, retry: vi.fn(), options: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/hooks/usePlatformWhatsAppNotices', () => ({ usePlatformWhatsAppNotices: (options: unknown) => { mock.options(options); return mock.query; }, useRetryPlatformWhatsAppNotice: () => ({ mutateAsync: mock.retry, isPending: false }) }));
vi.mock('sonner', () => ({ toast: { success: mock.success, info: mock.info, error: vi.fn() } }));
const notice = (status: PlatformWhatsAppNotice['status'], index = 0): PlatformWhatsAppNotice => ({ id: `id-${status}-${index}`, batch_id: 'batch', company_id: 'company', company_name: `Empresa ${status}`, recipient_phone: '+5562999659667', image_path: 'notification-images/33333333-3333-4333-8333-333333333333.png', caption: 'Aviso com imagem', status, attempts: 1, error_message: null, created_at: '2026-11-22T15:00:00Z', processed_at: null });
beforeEach(() => { vi.clearAllMocks(); mock.query = { data: { rows: [notice('accepted'), notice('unknown'), notice('failed'), notice('skipped')], total: 4 }, isPending: false, isError: false, isFetching: false, refetch: vi.fn() }; mock.retry.mockResolvedValue({ rows: [{ ...notice('failed'), status: 'queued' }] }); });
afterEach(cleanup);
describe('PlatformWhatsAppNoticeHistory', () => {
  it('offers retries only for definitive failures or skipped contacts', async () => {
    render(<PlatformWhatsAppNoticeHistory/>);
    expect(screen.getByText('Enviado', { exact: true })).toBeVisible();
    expect(screen.getByText('Sem confirmação')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Tentar novamente para Empresa accepted/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tentar novamente para Empresa unknown/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente para Empresa failed' }));
    await waitFor(() => expect(mock.retry).toHaveBeenCalledWith({ notice_id: 'id-failed-0' }));
    expect(mock.success).toHaveBeenCalledWith('Nova tentativa adicionada à fila.');
    expect(screen.getByRole('button', { name: 'Tentar novamente para Empresa skipped' })).toBeVisible();
  });
  it('does not report a new queued send when the responsible contact is still missing', async () => {
    mock.retry.mockResolvedValue({ rows: [{ ...notice('skipped'), error_message: 'Cadastre o telefone do responsável.' }] });
    render(<PlatformWhatsAppNoticeHistory/>);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente para Empresa skipped' }));
    await waitFor(() => expect(mock.info).toHaveBeenCalledWith('Cadastre o telefone do responsável.'));
    expect(mock.success).not.toHaveBeenCalled();
  });
  it('shows query failure separately from an empty history and retries the actual query', () => {
    mock.query.data = undefined; mock.query.isError = true;
    render(<PlatformWhatsAppNoticeHistory/>);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar');
    expect(screen.queryByText('Nenhum envio pelo WhatsApp neste recorte.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' })); expect(mock.query.refetch).toHaveBeenCalledOnce();
  });
  it('requests the following server page rather than slicing visible records', () => {
    mock.query.data.total = 60; render(<PlatformWhatsAppNoticeHistory/>);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(mock.options).toHaveBeenLastCalledWith({ enabled: true, offset: 25, limit: 25 });
    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
    expect(mock.options).toHaveBeenLastCalledWith({ enabled: true, offset: 0, limit: 25 });
  });
});
