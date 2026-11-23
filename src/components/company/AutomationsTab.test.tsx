import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import AutomationsTab from './AutomationsTab';

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

vi.mock('./PlugueChatMessages', () => ({
  default: () => <div data-testid="official-messages" />,
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

function selectAutomation(label: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
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
  fireEvent.mouseDown(screen.getByRole('tab', { name: /automações/i }), { button: 0, ctrlKey: false });
  selectAutomation('Mensagem Pós-Visita');
  return result;
}

describe('AutomationsTab', () => {
  beforeEach(() => {
    sessionStorage.clear();
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
    fireEvent.mouseDown(screen.getByRole('tab', { name: /automações/i }), { button: 0, ctrlKey: false });

    selectAutomation('Entrada na Lista de Espera');
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Ativar Entrada na Lista de Espera' })).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('saves activation and edited text together only after explicit Save', async () => {
    const companyId = 'company-1';
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
    fireEvent.mouseDown(screen.getByRole('tab', { name: /automações/i }), { button: 0, ctrlKey: false });

    selectAutomation('Chamada da Lista de Espera');
    const toggle = screen.getByRole('switch', { name: 'Ativar Chamada da Lista de Espera' });
    fireEvent.click(toggle);

    const card = toggle.closest('.bg-card') as HTMLElement;
    fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'Sua mesa está pronta, {nome}!' } });
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(within(card).getByRole('status')).toHaveTextContent('Alterações não salvas');
    fireEvent.click(within(card).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        company_id: companyId,
        type: 'waitlist_called',
        enabled: true,
        message_template: 'Sua mesa está pronta, {nome}!',
      });
    });
    await waitFor(() => expect(within(card).queryByRole('status')).not.toBeInTheDocument());
  });

  it('offers the complete-URL review variable when centrally enabled without requiring it in the message', () => {
    renderPostVisit();

    expect(useCompanyNpsActivationMock).toHaveBeenCalledWith('company-1');
    expect(getPostVisitCard().getByRole('button', { name: 'Inserir Link da avaliação' })).toBeInTheDocument();
    expect(getPostVisitCard().getByText(/recebe o endereço completo da avaliação/)).toBeInTheDocument();
    expect(getPostVisitCard().getByText(/Usar a variável no pós-visita é opcional/)).toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Olá, {nome}! Obrigado pela visita no dia {data}.');
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('keeps name/date-only messages enabled and saveable when reviews are off', async () => {
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    renderPostVisit();

    expect(getPostVisitCard().queryByRole('button', { name: 'Inserir Link da avaliação' })).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('button', { name: 'Inserir Nome' })).toBeInTheDocument();
    expect(getPostVisitCard().getByRole('button', { name: 'Inserir Data' })).toBeInTheDocument();
    expect(getPostVisitCard().queryByText(/avaliaç/i)).not.toBeInTheDocument();
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(getPostVisitCard().getByRole('switch')).not.toBeDisabled();
    expect(getPostVisitCard().getByRole('textbox')).not.toBeDisabled();
    expect(getPostVisitCard().getByRole('button', { name: 'Salvar' })).toBeDisabled();
    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Olá, {nome}! Obrigado pela visita no dia {data}. Até breve!' } });
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledWith({
      company_id: 'company-1',
      type: 'post_visit',
      enabled: true,
      message_template: 'Olá, {nome}! Obrigado pela visita no dia {data}. Até breve!',
    }));
  });

  it('hides review guidance when disabled without deleting the saved message or disabling the automation', async () => {
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    const message = 'Olá, {nome}! Avalie sua visita: {link_avaliacao}';
    renderPostVisit(message);

    expect(getPostVisitCard().queryByRole('button', { name: 'Inserir Link da avaliação' })).not.toBeInTheDocument();
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().queryByText(/recebe o endereço completo da avaliação/)).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue(message);
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    fireEvent.click(getPostVisitCard().getByRole('switch'));
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      message_template: message,
      enabled: false,
    })));
  });

  it.each([
    { label: 'loading', isPending: true, isError: false },
    { label: 'failed refresh', isPending: false, isError: true },
  ])('hides all review UI when availability is $label even with a cached enabled value', ({ isPending, isError }) => {
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: true }, isPending, isError });
    renderPostVisit();

    expect(getPostVisitCard().queryByRole('button', { name: 'Inserir Link da avaliação' })).not.toBeInTheDocument();
    expect(getPostVisitCard().queryByText(/avaliaç/i)).not.toBeInTheDocument();
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).not.toBeDisabled();
    expect(getPostVisitCard().getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('reacts to activation changes without autosaving or resetting an edited message', () => {
    const { rerender } = renderPostVisit();
    const draft = 'Oi, {nome}! Avalie a visita do dia {data}: {link_avaliacao}';
    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: draft } });

    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    rerender(<AutomationsTab companyId="company-1" />);
    expect(getPostVisitCard().queryByRole('button', { name: 'Inserir Link da avaliação' })).not.toBeInTheDocument();
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().queryByText(/recebe o endereço completo da avaliação/)).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue(draft);
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(mutateAsyncMock).not.toHaveBeenCalled();

    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: true }, isPending: false, isError: false });
    rerender(<AutomationsTab companyId="company-1" />);
    expect(getPostVisitCard().getByRole('button', { name: 'Inserir Link da avaliação' })).toBeInTheDocument();
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue(draft);
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('keeps review guidance hidden while the operator edits a saved message with reviews disabled', () => {
    useCompanyNpsActivationMock.mockReturnValue({ data: { enabled: false }, isPending: false, isError: false });
    renderPostVisit('Olá, {nome}! Avalie: {link_avaliacao}');
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Olá, {nome}! Obrigado pela visita.' } });
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
    expect(getPostVisitCard().queryByText(/recebe o endereço completo da avaliação/)).not.toBeInTheDocument();
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Olá, {nome}! Obrigado pela visita.');
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('keeps a failed save editable, retries the same draft and then clears its dirty state', async () => {
    mutateAsyncMock.mockRejectedValueOnce(new Error('offline'));
    renderPostVisit();
    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Obrigado, {nome}!' } });
    fireEvent.click(getPostVisitCard().getByRole('switch'));
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(getPostVisitCard().getByRole('alert')).toHaveTextContent('Suas alterações foram mantidas'));
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Obrigado, {nome}!');
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(getPostVisitCard().queryByRole('status')).not.toBeInTheDocument());
    expect(mutateAsyncMock).toHaveBeenCalledTimes(2);
    expect(mutateAsyncMock.mock.calls[0]).toEqual(mutateAsyncMock.mock.calls[1]);
    expect(getPostVisitCard().queryByRole('alert')).not.toBeInTheDocument();
  });

  it('discards all fields of one card without saving', () => {
    renderPostVisit();
    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Rascunho' } });
    fireEvent.click(getPostVisitCard().getByRole('switch'));
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Descartar' }));
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Olá, {nome}! Obrigado pela visita no dia {data}.');
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(getPostVisitCard().queryByRole('status')).not.toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('does not replace unknown settings with defaults after a failed initial read', () => {
    const refetch = vi.fn();
    useAutomationSettingsMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<AutomationsTab companyId="company-1" />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /automações/i }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar as automações');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('never exposes editable defaults while the first settings read is paused offline', () => {
    useAutomationSettingsMock.mockReturnValue({ data: undefined, isPending: true, isLoading: false, fetchStatus: 'paused' });
    render(<AutomationsTab companyId="company-1" />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /automações/i }), { button: 0, ctrlKey: false });
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('preserves a dirty message on refresh while refreshing untouched activation', () => {
    const { rerender } = renderPostVisit();
    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Minha edição' } });
    const original = useAutomationSettingsMock().data[0];
    useAutomationSettingsMock.mockReturnValue({ data: [{ ...original, enabled: false, message_template: 'Texto de outro operador' }], isLoading: false });
    rerender(<AutomationsTab companyId="company-1" />);
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Minha edição');
    expect(getPostVisitCard().getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Descartar' }));
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Texto de outro operador');
  });

  it('keeps dirty messages and leave warnings when changing internal tabs', () => {
    renderPostVisit();
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Minha edição' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: /canal/i }), { button: 0, ctrlKey: false });
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /automações/i }), { button: 0, ctrlKey: false });
    expect(getPostVisitCard().getByRole('textbox')).toHaveValue('Minha edição');
    fireEvent.click(getPostVisitCard().getByRole('button', { name: 'Descartar' }));
    const discardedEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(discardedEvent);
    expect(discardedEvent.defaultPrevented).toBe(false);
  });

  it('remembers tabs per unit and never carries a draft into a different unit', () => {
    const { rerender } = renderPostVisit();
    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Rascunho da unidade 1' } });
    sessionStorage.setItem('automations:tab:company-2', 'history');
    useAutomationSettingsMock.mockReturnValue({ data: [], isLoading: false });
    rerender(<AutomationsTab companyId="company-2" />);
    expect(screen.getByRole('tab', { name: /histórico/i })).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseDown(screen.getByRole('tab', { name: /automações/i }), { button: 0, ctrlKey: false });
    selectAutomation('Mensagem Pós-Visita');
    expect(getPostVisitCard().getByRole('textbox')).not.toHaveValue('Rascunho da unidade 1');
    expect(screen.queryByText('Alterações não salvas')).not.toBeInTheDocument();
    rerender(<AutomationsTab companyId="company-1" />);
    expect(screen.getByRole('tab', { name: /automações/i })).toHaveAttribute('aria-selected', 'true');
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('renders a deterministic fictitious preview of edited text without saving or sending', () => {
    renderPostVisit();
    fireEvent.change(getPostVisitCard().getByRole('textbox'), { target: { value: 'Olá, {nome}! {pessoas} pessoas em {data}, {hora}.' } });
    expect(getPostVisitCard().getByTestId('automation-preview-post_visit')).toHaveTextContent('Olá, Maria! 4 pessoas em 05/12/2026, 19:00.');
    expect(getPostVisitCard().getByText(/Nenhuma mensagem será enviada/)).toBeInTheDocument();
    expect(getPostVisitCard().getByText(/esta tela não calcula um horário individual/)).toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });
});
