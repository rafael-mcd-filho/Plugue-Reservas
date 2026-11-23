import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminNotifications from './AdminNotifications';

const mock = vi.hoisted(() => ({
  panel: { data: undefined as unknown, isPending: false, isError: false, refetch: vi.fn() },
  whatsapp: { data: undefined as unknown, isPending: false, isError: false, refetch: vi.fn() },
  retry: vi.fn(),
}));

vi.mock('@/hooks/useCompanies', () => ({
  useCompanies: () => ({
    data: [{ id: 'a', name: 'Beco Mágico - Goiânia' }, { id: 'b', name: 'Beco Mágico - Natal' }, { id: 'c', name: 'Space Pizza' }],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useSettings', () => ({
  useNotifications: () => mock.panel,
  useDeleteNotificationBatch: () => ({ mutate: vi.fn(), isPending: false }),
  useNotificationRecipientStatuses: () => ({ data: [], isPending: false, isError: false }),
}));
vi.mock('@/hooks/usePlatformWhatsAppNotices', () => ({
  useAllPlatformWhatsAppNotices: () => mock.whatsapp,
  useRetryPlatformWhatsAppNotice: () => ({ mutateAsync: mock.retry, isPending: false }),
}));
vi.mock('@/components/notifications/AdminNotificationComposer', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const row = (id: string, company: string, read: number, total: number) => ({
  id,
  company_id: company,
  title: 'Atualizações no painel',
  message: '<p>Fizemos melhorias&nbsp;no <strong>menu</strong>.</p>',
  image_url: null,
  type: 'info',
  is_read: false,
  read_at: null,
  created_by: 'admin',
  created_at: '2026-09-23T15:26:00.000Z',
  recipient_count: total,
  read_count: read,
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/notificacoes']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AdminNotifications />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mock.panel = { data: [row('1', 'a', 4, 5), row('2', 'b', 4, 4), row('3', 'c', 0, 3)], isPending: false, isError: false, refetch: vi.fn() };
  mock.whatsapp = { data: { rows: [], total: 0, truncated: false }, isPending: false, isError: false, refetch: vi.fn() };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AdminNotifications', () => {
  it('shows one row per send with a clean preview and named bases for the metrics', () => {
    renderPage();
    const rows = screen.getAllByRole('button', { name: /Atualizações no painel/ });
    expect(rows).toHaveLength(1);
    const item = within(rows[0]);
    expect(item.getByText('Fizemos melhorias no menu.')).toBeInTheDocument();
    expect(screen.queryByText(/<p>/)).not.toBeInTheDocument();
    expect(item.getByText('Todas · 3 empresas')).toBeInTheDocument();
    expect(item.getByText('8 de 12 usuários leram')).toBeInTheDocument();
    expect(item.getByText('2 de 3 empresas com leitura')).toBeInTheDocument();
  });

  it('keeps a failed WhatsApp query apart from the panel results', () => {
    mock.whatsapp = { data: undefined, isPending: false, isError: true, refetch: vi.fn() };
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar os avisos por WhatsApp');
    expect(screen.getByRole('button', { name: /Atualizações no painel/ })).toBeInTheDocument();
  });

  it('reports a full failure instead of an empty history', () => {
    mock.panel = { data: undefined, isPending: false, isError: true, refetch: vi.fn() };
    mock.whatsapp = { data: undefined, isPending: false, isError: true, refetch: vi.fn() };
    renderPage();
    expect(screen.getByText('Não foi possível carregar os avisos')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum aviso enviado ainda')).not.toBeInTheDocument();
  });

  it('opens the send detail with each company and the action to withdraw it from the panel', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Atualizações no painel/ }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Beco Mágico - Natal')).toBeInTheDocument();
    expect(dialog.getByText('Todos leram (4)')).toBeInTheDocument();
    expect(dialog.getByText('0 de 3 leram')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: /Retirar do painel/ })).toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: /Reenviar para quem não leu/ })).not.toBeInTheDocument();
  });
});
