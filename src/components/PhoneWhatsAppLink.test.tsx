import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PhoneWhatsAppLink from '@/components/PhoneWhatsAppLink';

const useAutomationSettingsMock = vi.fn();

vi.mock('@/hooks/useAutomations', () => ({
  useAutomationSettings: (...args: unknown[]) => useAutomationSettingsMock(...args),
}));

describe('PhoneWhatsAppLink', () => {
  beforeEach(() => {
    useAutomationSettingsMock.mockReset();
    useAutomationSettingsMock.mockReturnValue({
      data: [
        {
          id: 'automation-1',
          company_id: 'company-1',
          type: 'confirmation_message',
          enabled: true,
          message_template: 'Olá, {nome}! Sua reserva para {pessoas} pessoas será em {data} às {hora}. {link_acompanhamento}',
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
      isError: false,
    });
  });

  it('keeps an existing BR contact clickable without changing its local digits', () => {
    render(<PhoneWhatsAppLink phone="(11) 9999-8888" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://wa.me/551199998888');
  });

  it('opens the template picker and starts WhatsApp with the rendered message', () => {
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <PhoneWhatsAppLink
        phone="(85) 99999-0000"
        companyId="company-1"
        slug="restaurante"
        reservation={{
          guest_name: 'Ana Maria Souza',
          guest_phone: '(85) 99999-0000',
          date: '2026-06-02',
          time: '20:30:00',
          party_size: 4,
          public_tracking_code: 'codigo',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Abrir WhatsApp de (85) 99999-0000' }));

    expect(screen.getByRole('dialog', { name: 'Abrir conversa no WhatsApp' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Mensagem de Confirmação/i }));

    expect(openMock).toHaveBeenCalledWith(
      `https://api.whatsapp.com/send?phone=5585999990000&text=${encodeURIComponent(
        'Olá, Ana! Sua reserva para 4 pessoas será em 02/06/2026 às 20:30. http://localhost:3000/restaurante/reserva/codigo',
      )}`,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('preserves emoji and line breaks when opening a saved reminder on WhatsApp', () => {
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => null);
    useAutomationSettingsMock.mockReturnValue({
      data: [{
        type: 'reminder_1h',
        enabled: true,
        message_template: '🚀 Olá, {nome}! Reserva às {hora} para {pessoas}.\n⏰ Tolerância de 10 minutos. 👩🏽‍🍳 ❤️ Pizza & diversão 😋',
      }],
      isLoading: false,
      isError: false,
    });

    render(<PhoneWhatsAppLink
      phone="+1 407 264 1934"
      companyId="company-1"
      reservation={{ guest_name: 'Ana Maria', time: '19:45:00', party_size: 2 }}
    />);
    fireEvent.click(screen.getByRole('button', { name: /Abrir WhatsApp de/ }));
    fireEvent.click(screen.getByRole('button', { name: /Lembrete de Logo Mais/i }));

    const url = new URL(String(openMock.mock.calls.at(-1)?.[0]));
    expect(url.origin).toBe('https://api.whatsapp.com');
    expect(url.searchParams.get('phone')).toBe('14072641934');
    expect(url.searchParams.get('text')).toBe(
      '🚀 Olá, Ana! Reserva às 19:45 para 2.\n⏰ Tolerância de 10 minutos. 👩🏽‍🍳 ❤️ Pizza & diversão 😋',
    );
  });
});
