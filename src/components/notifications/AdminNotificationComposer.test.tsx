import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Company } from '@/hooks/useCompanies';
import AdminNotificationComposer from './AdminNotificationComposer';

const mock = vi.hoisted(() => ({ panel: vi.fn(), whatsapp: vi.fn(), upload: vi.fn(), changed: vi.fn(), created: vi.fn() }));
vi.mock('@/hooks/useSettings', () => ({ useCreateNotification: () => ({ mutateAsync: mock.panel, isPending: false }) }));
vi.mock('@/hooks/usePlatformWhatsAppNotices', () => ({ useCreatePlatformWhatsAppNotice: () => ({ mutateAsync: mock.whatsapp, isPending: false }) }));
vi.mock('@/lib/platform-whatsapp-notices', async original => ({ ...await original<typeof import('@/lib/platform-whatsapp-notices')>(), uploadNoticeImage: mock.upload }));
vi.mock('@/components/RichTextEditor', () => ({ default: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => <textarea aria-label="Mensagem do painel" value={content} onChange={event => onChange(event.target.value)}/> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const path = 'notification-images/33333333-3333-4333-8333-333333333333.png';
const companies = [
  { id: a, name: 'Empresa Alfa', responsible_phone: '(62) 99965-9667', responsible_phone_e164: '+5562999659667', phone: '+5511999991111' },
  { id: b, name: 'Empresa Beta', responsible_phone: null, responsible_phone_e164: null, phone: '+5511999992222', whatsapp: '+5511999993333' },
] as Company[];
function mount(props: Partial<Parameters<typeof AdminNotificationComposer>[0]> = {}) {
  return render(<AdminNotificationComposer open onOpenChange={mock.changed} onCreated={mock.created} companies={companies} {...props}/>);
}
async function prepareWhatsApp() {
  fireEvent.click(screen.getByRole('radio', { name: /WhatsApp/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Empresa Alfa/ }));
  fireEvent.change(screen.getByLabelText('Legenda *'), { target: { value: 'Aviso para o gestor\nConfira a novidade.' } });
  await act(async () => { fireEvent.change(screen.getByLabelText('Selecionar imagem do aviso'), { target: { files: [new File(['image'], 'aviso.png', { type: 'image/png' })] } }); });
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.clearAllMocks(); mock.panel.mockResolvedValue(undefined); mock.whatsapp.mockResolvedValue({ rows: [], total: 1 });
  mock.upload.mockResolvedValue({ path, url: 'https://assets.invalid/aviso.png' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AdminNotificationComposer', () => {
  it('filters the recipient list by name and keeps the selection count', () => {
    mount(); fireEvent.click(screen.getByRole('checkbox', { name: /Todas as empresas/ }));
    fireEvent.change(screen.getByLabelText('Buscar empresa'), { target: { value: 'beta' } });
    expect(screen.queryByRole('checkbox', { name: /Empresa Alfa/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Empresa Beta/ }));
    expect(screen.getByText('1 selecionada')).toBeVisible();
  });
  it('opens prefilled from a duplicated send', () => {
    mount({ initialDraft: { channel: 'panel', title: 'Manutenção', message: '<p>Texto</p>', type: 'warning', companyIds: [b] } });
    expect(screen.getByLabelText('Título *')).toHaveValue('Manutenção');
    expect(screen.getByRole('checkbox', { name: /Empresa Beta/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Empresa Alfa/ })).not.toBeChecked();
  });
  it('keeps the current panel channel and existing creation payload', async () => {
    mount(); expect(screen.getByRole('radio', { name: /Painel/ })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Título *'), { target: { value: 'Manutenção' } });
    fireEvent.change(screen.getByLabelText('Mensagem do painel'), { target: { value: '<p>Aviso no painel.</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar aviso' }));
    expect(mock.panel).not.toHaveBeenCalled();
    expect(screen.getByText('Confirme o envio para 2 empresas.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar envio para 2 empresas' }));
    await waitFor(() => expect(mock.panel).toHaveBeenCalledWith({ company_ids: [a, b], title: 'Manutenção', message: '<p>Aviso no painel.</p>', type: 'info', image_url: null }));
    expect(mock.whatsapp).not.toHaveBeenCalled(); expect(mock.created).toHaveBeenCalledWith('panel');
  });
  it('sends an image and plain caption through WhatsApp only after selecting a company', async () => {
    mount(); await prepareWhatsApp();
    expect(screen.queryByLabelText('Título *')).not.toBeInTheDocument();
    expect(screen.getByText(/telefone do responsável cadastrado/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pelo WhatsApp' }));
    await waitFor(() => expect(mock.whatsapp).toHaveBeenCalledWith({ company_ids: [a], request_id: expect.any(String), image_path: path, caption: 'Aviso para o gestor\nConfira a novidade.' }));
    expect(mock.panel).not.toHaveBeenCalled(); expect(mock.created).toHaveBeenCalledWith('whatsapp');
  });
  it('does not use the primary or public number when the responsible contact is missing', async () => {
    mount(); await prepareWhatsApp();
    fireEvent.click(screen.getByRole('checkbox', { name: /Empresa Alfa/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Empresa Beta/ }));
    expect(screen.getByText('Sem telefone válido do responsável')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enviar pelo WhatsApp' })).toBeDisabled();
    expect(mock.whatsapp).not.toHaveBeenCalled();
  });
  it('preserves the draft and reuses the request ID after an uncertain network response', async () => {
    mock.whatsapp.mockRejectedValueOnce(new Error('Conexão interrompida. Confira o histórico antes de reenviar.'));
    mount(); await prepareWhatsApp();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pelo WhatsApp' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Conexão interrompida');
    expect(screen.getByLabelText('Legenda *')).toHaveValue('Aviso para o gestor\nConfira a novidade.');
    expect(mock.changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pelo WhatsApp' }));
    await waitFor(() => expect(mock.whatsapp).toHaveBeenCalledTimes(2));
    expect(mock.whatsapp.mock.calls[1][0].request_id).toBe(mock.whatsapp.mock.calls[0][0].request_id);
    expect(mock.panel).not.toHaveBeenCalled();
  });
  it('keeps an invalid image from registering a send or falling back to the panel', async () => {
    mock.upload.mockRejectedValue(new Error('Envie uma imagem PNG ou JPG.'));
    mount(); await prepareWhatsApp();
    expect(screen.getByRole('alert')).toHaveTextContent('PNG ou JPG');
    expect(screen.getByRole('button', { name: 'Enviar pelo WhatsApp' })).toBeDisabled();
    expect(mock.panel).not.toHaveBeenCalled(); expect(mock.whatsapp).not.toHaveBeenCalled();
  });
  it('blocks submission while the image is still being uploaded', async () => {
    let finish!: (value: { path: string; url: string }) => void;
    mock.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mount(); fireEvent.click(screen.getByRole('radio', { name: /WhatsApp/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Empresa Alfa/ }));
    fireEvent.change(screen.getByLabelText('Legenda *'), { target: { value: 'Aviso' } });
    fireEvent.change(screen.getByLabelText('Selecionar imagem do aviso'), { target: { files: [new File(['image'], 'aviso.png', { type: 'image/png' })] } });
    expect(screen.getByRole('button', { name: 'Enviar pelo WhatsApp' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    await act(async () => finish({ path, url: 'https://assets.invalid/aviso.png' }));
    expect(screen.getByRole('button', { name: 'Enviar pelo WhatsApp' })).toBeEnabled();
  });
});
