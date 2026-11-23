import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationBanner from './NotificationBanner';
import CompanyNotificationsPopover from './CompanyNotificationsPopover';

const mock = vi.hoisted(() => ({ notifications: [] as Array<Record<string, unknown>>, markRead: vi.fn() }));
vi.mock('@/hooks/useSettings', () => ({
  useCompanyNotifications: () => ({ data: mock.notifications, isLoading: false }),
  useCompanyAnnouncementNotifications: () => ({ data: mock.notifications, isLoading: false }),
  useMarkNotificationsRead: () => ({ mutate: mock.markRead, isPending: false }),
}));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: 'company-a' }) }));

function notice(id: string, type: string, overrides: Record<string, unknown> = {}) {
  return {
    id, type, title: id, message: `<p>Mensagem ${id}</p>`, company_id: 'company-a',
    is_read: false, image_url: null, created_at: '2026-11-22T15:00:00Z', ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.notifications = [];
});
afterEach(cleanup);

describe('operational reservation changes and company announcements', () => {
  it('does not open a blocking banner or mark an operational change as read', () => {
    mock.notifications = [notice('Reserva remarcada', 'reservation_change')];
    const { container } = render(<NotificationBanner companyId="company-a" />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Reserva remarcada')).not.toBeInTheDocument();
    expect(mock.markRead).not.toHaveBeenCalled();
  });

  it('keeps ordinary announcements in the banner and marks all of those without reading operational changes', () => {
    mock.notifications = [
      notice('Remarcação recente', 'reservation_change'),
      notice('Manutenção programada', 'warning'),
      notice('Outra remarcação', 'reservation_change'),
      notice('Novidades do painel', 'info'),
      notice('Aviso já lido', 'success', { is_read: true }),
    ];
    render(<NotificationBanner companyId="company-a" />);
    expect(screen.getByText('Manutenção programada')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.queryByText('Remarcação recente')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar todas' }));
    expect(mock.markRead).toHaveBeenCalledWith({
      companyId: 'company-a', ids: ['Manutenção programada', 'Novidades do painel'],
    });
  });

  it('excludes only reservation_change and preserves the existing fallback for another notification type', () => {
    mock.notifications = [notice('Reserva remarcada', 'reservation_change'), notice('Aviso especial', 'custom_type')];
    render(<NotificationBanner companyId="company-a" />);
    expect(screen.getByText('Aviso especial')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como lido' }));
    expect(mock.markRead).toHaveBeenCalledWith({ companyId: 'company-a', ids: ['Aviso especial'] });
    expect(screen.queryByRole('button', { name: 'Marcar todas' })).not.toBeInTheDocument();
  });

  it('keeps customer changes visible and readable in the bell without turning escaped guest text into HTML', async () => {
    mock.notifications = [
      notice('Reserva remarcada', 'reservation_change', { message: '<p>Cliente: &lt;img src=x onerror=alert(1)&gt;</p>' }),
      notice('Atualização do painel', 'info'),
    ];
    const { container } = render(<CompanyNotificationsPopover />);
    fireEvent.click(screen.getByRole('button', { name: 'Notificações da empresa' }));
    expect(await screen.findByText('Avisos para esta unidade')).toBeInTheDocument();
    expect(screen.getByText('Reserva remarcada')).toBeInTheDocument();
    expect(screen.getByText('Atualização do painel')).toBeInTheDocument();
    expect(screen.getByText('Cliente: <img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.ownerDocument.querySelector('img[src="x"]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar lidas' }));
    expect(mock.markRead).toHaveBeenCalledWith({ companyId: 'company-a', ids: ['Reserva remarcada', 'Atualização do painel'] });
  });
});
