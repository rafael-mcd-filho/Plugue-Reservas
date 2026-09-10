import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import AutomationsTab from './AutomationsTab';
import { WHATSAPP_AUTOMATIONS } from '@/lib/whatsapp-automations';

const useAutomationSettingsMock = vi.fn();
const mutateAsyncMock = vi.fn();
const useWhatsAppChannelMock = vi.fn();
const useCompanyNpsActivationMock = vi.fn();

vi.mock('@/hooks/useCompanyNpsActivation', () => ({
  useCompanyNpsActivation: (...args: unknown[]) => useCompanyNpsActivationMock(...args),
}));

vi.mock('./WhatsAppConnection', () => ({
  default: () => <div data-testid="whatsapp-connection" />,
}));

vi.mock('./WhatsAppMessageHistory', () => ({
  default: () => <div data-testid="whatsapp-history" />,
}));

vi.mock('./ChannelTab', () => ({
  default: () => <div data-testid="channel-tab" />,
}));

vi.mock('@/hooks/useAutomations', () => ({
  useAutomationSettings: (...args: unknown[]) => useAutomationSettingsMock(...args),
  useUpsertAutomation: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock('@/hooks/useWhatsAppChannel', () => ({
  useWhatsAppChannel: (...args: unknown[]) => useWhatsAppChannelMock(...args),
  useSwitchWhatsAppChannel: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

function getPostVisitCard() {
  const card = screen.getByRole('heading', { name: 'Mensagem Pós-Visita' }).closest('.bg-card');
  if (!(card instanceof HTMLElement)) throw new Error('Missing post-visit automation card');
  return within(card);
}

function renderPostVisit(messageTemplate = 'Olá, {nome}! Obrigado pela visita no dia {data}.') {
  useAutomationSettingsMock.mockReturnValue({
    data: [{
      id: 'post-visit-1',
      company_id: 'company-1',
      type: 'post_visit',
      enabled: true,
      message_template: messageTemplate,
      created_at: '2026-09-10T00:00:00.000Z',
      updated_at: '2026-09-10T00:00:00.000Z',
    }],
    isLoading: false,
  });
  const result = render(<AutomationsTab companyId="company-1" />);
  fireEvent.mouseDown(screen.getByRole('tab', { name: /mensagens/i }), { button: 0, ctrlKey: false });
  return result;
}

describe('AutomationsTab', () => {
  beforeEach(() => {
    useAutomationSettingsMock.mockReset();
    useWhatsAppChannelMock.mockReset();
    useWhatsAppChannelMock.mockReturnValue({ data: 'evolution', isLoading: false });
    useCompanyNpsActivationMock.mockReset();
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: true }, isPending: false, isError: false });
    mutateAsyncMock.mockReset();
    mutateAsyncMock.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

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
    fireEvent.mouseDown(screen.getByRole('tab', { name: /mensagens/i }), { button: 0, ctrlKey: false });

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
    fireEvent.mouseDown(screen.getByRole('tab', { name: /mensagens/i }), { button: 0, ctrlKey: false });

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

  it('offers the complete-URL review variable when centrally enabled without requiring it in the message', () => {
    renderPostVisit();

    expect(useCompanyNpsActivationMock).toHaveBeenCalledWith('company-1');
    expect(getPostVisitCard().getByText('{link_avaliacao}', { exact: true })).toBeInTheDocument();
    expect(getPostVisitCard().getByText(/recebe o endereço completo da avaliação/)).toBeInTheDocument();
    expect(getPostVisitCard().getByText(/Usar a variável no pós-visita é opcional/)).toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Olá, {nome}! Obrigado pela visita no dia {data}.');
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('keeps name/date-only messages enabled and saveable when reviews are off', async () => {
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    renderPostVisit();

    expect(getPostVisitCard().queryByText('{link_avaliacao}', { exact: true })).not.toBeInTheDocument();
    expect(getPostVisitCard().getByText('{nome}', { exact: true })).toBeInTheDocument();
    expect(getPostVisitCard().getByText('{data}', { exact: true })).toBeInTheDocument();
    expect(getPostVisitCard().getByText(/O pós-visita sem avaliação continua funcionando/)).toBeInTheDocument();
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(getPostVisitCard().getByRole('switch')).not.toBeDisabled();
    expect(getPostVisitCard().getByRole('textbox')).not.toBeDisabled();
    expect(getPostVisitCard().getByRole('button', { name: 'Salvar' })).not.toBeDisabled();
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledWith({
      company_id: 'company-1',
      type: 'post_visit',
      enabled: true,
      message_template: 'Olá, {nome}! Obrigado pela visita no dia {data}.',
    }));
  });

  it('warns about a saved review dependency when disabled without deleting the variable or disabling the automation', async () => {
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    const message = 'Olá, {nome}! Avalie sua visita: {link_avaliacao}';
    renderPostVisit(message);

    expect(getPostVisitCard().queryByText('{link_avaliacao}', { exact: true })).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('alert')).toHaveTextContent('Este modelo utiliza avaliação, mas as avaliações estão desativadas');
    expect(getPostVisitCard().getByRole('alert')).toHaveTextContent('retirar a variável e o convite de avaliação do texto');
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue(message);
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      message_template: message,
      enabled: true,
    })));
  });

  it.each([
    { label: 'loading', isPending: true, isError: false, role: 'status', message: 'Verificando a disponibilidade' },
    { label: 'failed refresh', isPending: false, isError: true, role: 'alert', message: 'Não foi possível consultar' },
  ])('hides the variable when availability is $label even with a cached enabled value', ({ isPending, isError, role, message }) => {
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: true }, isPending, isError });
    renderPostVisit();

    expect(getPostVisitCard().queryByText('{link_avaliacao}', { exact: true })).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole(role)).toHaveTextContent(message);
    expect(getPostVisitCard().getByRole('textbox')).not.toBeDisabled();
    expect(getPostVisitCard().getByRole('button', { name: 'Salvar' })).not.toBeDisabled();
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('reacts to activation changes without autosaving or resetting an edited message', () => {
    const { rerender } = renderPostVisit();
    const draft = 'Oi, {nome}! Avalie a visita do dia {data}: {link_avaliacao}';
    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: draft } });

    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    rerender(<AutomationsTab companyId="company-1" />);
    expect(getPostVisitCard().queryByText('{link_avaliacao}', { exact: true })).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('alert')).toHaveTextContent('as avaliações estão desativadas');
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue(draft);
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(mutateAsyncMock).not.toHaveBeenCalled();

    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: true }, isPending: false, isError: false });
    rerender(<AutomationsTab companyId="company-1" />);
    expect(getPostVisitCard().getByText('{link_avaliacao}', { exact: true })).toBeInTheDocument();
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue(draft);
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('updates the dependency warning when the operator removes the variable, without modifying the text automatically', () => {
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    renderPostVisit('Olá, {nome}! Avalie: {link_avaliacao}');
    expect(getPostVisitCard().getByRole('alert')).toBeInTheDocument();

    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Olá, {nome}! Obrigado pela visita.' } });
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().getByText(/O pós-visita sem avaliação continua funcionando/)).toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Olá, {nome}! Obrigado pela visita.');
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });
});
