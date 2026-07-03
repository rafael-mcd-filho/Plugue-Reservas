import { describe, expect, it } from 'vitest';
import {
  RESERVATION_WHATSAPP_AUTOMATIONS,
  renderReservationWhatsAppTemplate,
} from '@/lib/whatsapp-automations';

describe('reservation WhatsApp automations', () => {
  it('keeps waitlist messages out of the reservation picker', () => {
    expect(RESERVATION_WHATSAPP_AUTOMATIONS.map((automation) => automation.type)).toEqual([
      'confirmation_message',
      'reminder_24h',
      'reminder_1h',
      'cancellation_message',
      'post_visit',
      'birthday_message',
      'no_show_message',
    ]);
  });

  it('renders reservation variables with the same formatting used by the backend', () => {
    expect(
      renderReservationWhatsAppTemplate(
        'Olá, {nome}! Reserva para {pessoas} em {data} às {hora}. WhatsApp: {telefone}. Link: {link_acompanhamento}',
        {
          guestName: '  Ana Maria Souza  ',
          guestPhone: '(85) 99999-0000',
          date: '2026-06-02',
          time: '20:30:00',
          partySize: 4,
          trackingUrl: 'https://example.com/restaurante/reserva/codigo',
        },
      ),
    ).toBe(
      'Olá, Ana! Reserva para 4 em 02/06/2026 às 20:30. WhatsApp: (85) 99999-0000. Link: https://example.com/restaurante/reserva/codigo',
    );
  });
});
