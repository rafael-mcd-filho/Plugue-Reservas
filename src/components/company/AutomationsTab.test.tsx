import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AutomationsTab from './AutomationsTab';
import { WHATSAPP_AUTOMATIONS } from '@/lib/whatsapp-automations';

const useAutomationSettingsMock = vi.fn();
const mutateAsyncMock = vi.fn();

vi.mock('./WhatsAppConnection', () => ({
  default: () => <div data-testid="whatsapp-connection" />,
}));

vi.mock('./WhatsAppMessageHistory', () => ({
  default: () => <div data-testid="whatsapp-history" />,
}));

vi.mock('@/hooks/useAutomations', () => ({
  useAutomationSettings: (...args: unknown[]) => useAutomationSettingsMock(...args),
  useUpsertAutomation: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
}));

describe('AutomationsTab', () => {
  beforeEach(() => {
    useAutomationSettingsMock.mockReset();
    mutateAsyncMock.mockReset();
    mutateAsyncMock.mockResolvedValue(undefined);
  });

  it('hydrates switches from fetched automations after the initial loading state', async () => {
    const companyId = 'company-1';
    const waitlistEntryIndex = WHATSAPP_AUTOMATIONS.findIndex((automation) => automation.type === 'waitlist_entry');

    useAutomationSettingsMock
      .mockReturnValueOnce({ data: undefined, isLoading: true })
      .mockReturnValue({
        data: [
          {
            id: 'automation-1',
            company_id: companyId,
            type: 'waitlist_entry',
            enabled: true,
            message_template: 'Mensagem salva',
            created_at: '2026-04-11T00:00:00.000Z',
            updated_at: '2026-04-11T00:00:00.000Z',
          },
        ],
        isLoading: false,
      });

    const { rerender } = render(<AutomationsTab companyId={companyId} />);

    rerender(<AutomationsTab companyId={companyId} />);

    await waitFor(() => {
      const switches = screen.getAllByRole('switch');
      expect(switches[waitlistEntryIndex]).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('persists the switch value immediately when the toggle changes', async () => {
    const companyId = 'company-1';
    const waitlistCalledIndex = WHATSAPP_AUTOMATIONS.findIndex((automation) => automation.type === 'waitlist_called');

    useAutomationSettingsMock.mockReturnValue({
      data: [
        {
          id: 'automation-2',
          company_id: companyId,
          type: 'waitlist_called',
          enabled: false,
          message_template: 'Mesa pronta',
          created_at: '2026-04-11T00:00:00.000Z',
          updated_at: '2026-04-11T00:00:00.000Z',
        },
      ],
      isLoading: false,
    });

    render(<AutomationsTab companyId={companyId} />);

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[waitlistCalledIndex]);

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        company_id: companyId,
        type: 'waitlist_called',
        enabled: true,
        message_template: 'Mesa pronta',
      });
    });
  });
});
