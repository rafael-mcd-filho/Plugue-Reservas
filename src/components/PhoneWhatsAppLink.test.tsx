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
      `https://wa.me/5585999990000?text=${encodeURIComponent(
        'Olá, Ana! Sua reserva para 4 pessoas será em 02/06/2026 às 20:30. http://localhost:3000/restaurante/reserva/codigo',
      )}`,
      '_blank',
      'noopener,noreferrer',
    );
  });
});
