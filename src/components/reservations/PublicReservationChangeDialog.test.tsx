import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicReservationChangeDialog } from './PublicReservationChangeDialog';
import type { PublicReservationChangeOptions, PublicReservationChangeResult } from '@/lib/public-reservation-changes';

const mocks = vi.hoisted(() => ({ options: vi.fn(), change: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/public-reservation-changes', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/public-reservation-changes')>(),
  getPublicReservationChangeOptions: mocks.options,
  changePublicReservation: mocks.change,
}));
vi.mock('@/hooks/useFunnelTracking', () => ({ getVisitorId: () => 'visitor-test' }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, info: mocks.info } }));

const reservation = { id: 'reservation-1', date: '2026-11-24', time: '19:00', party_size: 2, updated_at: '2026-11-22T12:00:00+00:00' };
function options(overrides: Partial<PublicReservationChangeOptions> = {}): PublicReservationChangeOptions {
  return { allowed: true, reason: null, revision: reservation.updated_at, reservation, min_notice_minutes: 120,
    time_zone: 'America/Sao_Paulo', server_now: '2026-11-22T12:00:00+00:00', date: reservation.date,
    party_size: 2, max_party_size: 20, slots: [
      { time: '19:00', available: true, reason: null, duration_minutes: 60 },
      { time: '20:00', available: true, reason: null, duration_minutes: 60 },
    ], ...overrides };
}
function result(overrides: Partial<PublicReservationChangeResult> = {}): PublicReservationChangeResult {
  return { changed: true, replayed: false, reason: null, revision: '2026-11-22T13:00:00+00:00',
    reservation: { ...reservation, party_size: 3, updated_at: '2026-11-22T13:00:00+00:00' }, ...overrides };
}
function setup(props: Partial<Parameters<typeof PublicReservationChangeDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  const onChanged = vi.fn(async () => undefined);
  const dialog = (nextProps: Partial<Parameters<typeof PublicReservationChangeDialog>[0]> = {}) => <QueryClientProvider client={client}><PublicReservationChangeDialog open onOpenChange={onOpenChange} onChanged={onChanged}
    companyName="Restaurante Teste" companyWhatsapp="5562999990000" guestName="Ana Teste" trackingCode="tracking-code"
    reservation={reservation} hasPayment={false} {...props} {...nextProps} /></QueryClientProvider>;
  const view = render(dialog());
  return { ...view, client, onOpenChange, onChanged, rerenderDialog: (nextProps: Partial<Parameters<typeof PublicReservationChangeDialog>[0]>) => view.rerender(dialog(nextProps)) };
}
async function continueToTimes() {
  const button = await screen.findByRole('button', { name: 'Continuar' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByRole('button', { name: 'Confirmar alteração' });
}
async function expectPeople(value: number) {
  const group = await screen.findByRole('group', { name: 'Quantas pessoas?' });
  expect(within(group).getByText(String(value), { exact: true })).toBeVisible();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.options.mockImplementation(async input => options({ date: input.date, party_size: input.partySize }));
  mocks.change.mockResolvedValue(result());
});
afterEach(() => cleanup());

describe('PublicReservationChangeDialog', () => {
  it('mantém o caminho atual do WhatsApp quando a empresa não ativou a função', async () => {
    mocks.options.mockResolvedValue(options({ allowed: false, reason: 'disabled', slots: [] }));
    setup();
    expect(await screen.findByRole('link', { name: 'Falar pelo WhatsApp' })).toHaveAttribute('href', expect.stringContaining('phone=5562999990000'));
    expect(screen.getByText(/Alterações de reserva são feitas de forma rápida pelo WhatsApp/)).toBeVisible();
    expect(screen.queryByLabelText('Quantas pessoas?')).not.toBeInTheDocument();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('mantém o comportamento atual quando a migração nova não está disponível', async () => {
    mocks.options.mockRejectedValue(new Error('function does not exist'));
    setup();
    expect(await screen.findByRole('link', { name: 'Falar pelo WhatsApp' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirmar alteração' })).not.toBeInTheDocument();
  });

  it('reservas com pagamento sempre vão ao WhatsApp sem consultar opções autônomas', async () => {
    setup({ hasPayment: true });
    expect(screen.getByRole('link', { name: 'Falar pelo WhatsApp' })).toBeVisible();
    expect(screen.getByText('Alterações de reservas com pagamento são feitas pelo WhatsApp.')).toBeVisible();
    expect(mocks.options).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('encaminha ao WhatsApp depois da antecedência mínima', async () => {
    mocks.options.mockResolvedValue(options({ allowed: false, reason: 'cutoff', slots: [] }));
    setup();
    expect(await screen.findByText(/O prazo para alterar pelo site terminou/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Falar pelo WhatsApp' })).toBeVisible();
  });

  it('abre com pessoas, data e horário atuais e não confirma sem mudanças', async () => {
    setup();
    await expectPeople(2);
    expect(screen.getByRole('button', { name: 'terça-feira, 24 de novembro de 2026' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('dialog').querySelector('input[type="date"]')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar alteração' })).not.toBeInTheDocument();
    await continueToTimes();
    expect(screen.getByRole('button', { name: '19:00' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeDisabled();
  });

  it('altera somente a quantidade e usa a mesma reserva, revisão e link de acompanhamento', async () => {
    const view = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Aumentar pessoas' }));
    await continueToTimes();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await waitFor(() => expect(view.onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ partySize: 3, date: reservation.date, reservationId: reservation.id }));
    expect(mocks.change).toHaveBeenCalledWith(expect.objectContaining({ reservationId: reservation.id, trackingCode: 'tracking-code', visitorId: 'visitor-test',
      date: reservation.date, time: '19:00', partySize: 3, revision: reservation.updated_at, requestId: expect.any(String) }));
    expect(view.onChanged).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith('Reserva alterada com sucesso.');
  });

  it('permite trocar a data e exige escolher o horário do novo dia', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'quarta-feira, 25 de novembro de 2026' }));
    await waitFor(() => expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ date: '2026-11-25', partySize: 2 })));
    await continueToTimes();
    expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: '20:00' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await waitFor(() => expect(mocks.change).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-11-25', time: '20:00', partySize: 2 })));
  });

  it('usa o calendário do sistema em português e volta à grade com a data escolhida', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Escolher outra data no calendário' }));
    const calendar = await screen.findByRole('grid');
    expect(screen.getByText('novembro 2026')).toBeVisible();
    expect(within(calendar).getByText('seg')).toBeVisible();
    fireEvent.click(within(calendar).getByRole('gridcell', { name: '25' }));
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'quarta-feira, 25 de novembro de 2026' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ date: '2026-11-25' })));
    await continueToTimes();
    expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeDisabled();
  });

  it('não permite destino com pagamento e oferece WhatsApp sem perder a escolha de data', async () => {
    mocks.options.mockImplementation(async input => options({ date: input.date, party_size: input.partySize,
      slots: [{ time: '19:00', available: false, reason: 'payment', duration_minutes: 60 }] }));
    setup();
    await continueToTimes();
    expect(screen.getByRole('button', { name: '19:00' })).toBeDisabled();
    expect(screen.getByText('Horários com pagamento precisam ser alterados pelo WhatsApp.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Prefere falar pelo WhatsApp?' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('button', { name: 'terça-feira, 24 de novembro de 2026' })).toBeEnabled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('explica quando os horários do destino não respeitam a antecedência mínima', async () => {
    mocks.options.mockResolvedValue(options({ slots: [{ time: '19:00', available: false, reason: 'cutoff', duration_minutes: 60 }] }));
    setup();
    await continueToTimes();
    expect(await screen.findByText('Nenhum horário atende à antecedência mínima nesta data. Escolha outra data.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('button', { name: 'terça-feira, 24 de novembro de 2026' })).toBeEnabled();
  });

  it('reutiliza a solicitação após resposta perdida, evitando criar uma alteração duplicada', async () => {
    mocks.change.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(result({ replayed: true }));
    const view = setup();
    await continueToTimes();
    fireEvent.click(await screen.findByRole('button', { name: '20:00' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Tente novamente para consultar a mesma solicitação/);
    expect(view.onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await waitFor(() => expect(view.onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.change.mock.calls[0][0].requestId).toBe(mocks.change.mock.calls[1][0].requestId);
  });

  it('mantém o formulário e informa que a vaga acabou sem fechar ou simular sucesso', async () => {
    mocks.change.mockResolvedValue(result({ changed: false, reason: 'full', reservation }));
    const view = setup();
    await continueToTimes();
    fireEvent.click(await screen.findByRole('button', { name: '20:00' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/acabou de ficar sem vagas/);
    expect(view.onOpenChange).not.toHaveBeenCalled();
    expect(view.onChanged).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('atualiza os dados de uma reserva alterada por outra pessoa e exige nova confirmação', async () => {
    const newer = { ...reservation, time: '20:00', party_size: 4, updated_at: '2026-11-22T14:00:00+00:00' };
    mocks.change.mockImplementation(async () => {
      mocks.options.mockImplementation(async input => options({ date: input.date, party_size: input.partySize, reservation: newer, revision: newer.updated_at }));
      return result({ changed: false, reason: 'stale', revision: newer.updated_at, reservation: newer });
    });
    const view = setup();
    await continueToTimes();
    fireEvent.click(await screen.findByRole('button', { name: '20:00' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/A reserva foi atualizada/);
    if (screen.queryByRole('button', { name: 'Alterar pessoas' })) {
      fireEvent.click(screen.getByRole('button', { name: 'Alterar pessoas' }));
    }
    await expectPeople(4);
    await continueToTimes();
    expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeDisabled();
    expect(view.onOpenChange).not.toHaveBeenCalled();
    expect(mocks.change).toHaveBeenCalledOnce();
  });

  it('deixa reduzir explicitamente grupos atuais maiores que o limite público', async () => {
    const large = { ...reservation, party_size: 22 };
    mocks.options.mockImplementation(async input => options({ reservation: large, party_size: input.partySize,
      slots: [{ time: '19:00', available: input.partySize <= 20, reason: input.partySize > 20 ? 'party_size' : null, duration_minutes: 60 }] }));
    setup({ reservation: large });
    await expectPeople(22);
    expect(screen.getByRole('button', { name: 'Aumentar pessoas' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Diminuir pessoas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Diminuir pessoas' }));
    await expectPeople(20);
    await continueToTimes();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeEnabled());
  });

  it('navega entre períodos sem descartar a data e o horário atuais', async () => {
    setup();
    await screen.findByRole('button', { name: 'terça-feira, 24 de novembro de 2026' });
    const requestsBeforePaging = mocks.options.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar próximos 6 dias' }));
    expect(screen.queryByRole('button', { name: 'terça-feira, 24 de novembro de 2026' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar 6 dias anteriores' }));
    expect(screen.getByRole('button', { name: 'terça-feira, 24 de novembro de 2026' })).toHaveAttribute('aria-pressed', 'true');
    expect(mocks.options.mock.calls).toHaveLength(requestsBeforePaging);
    await continueToTimes();
    expect(screen.getByRole('button', { name: '19:00' })).toHaveAttribute('aria-pressed', 'true');
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('enviar o formulário na etapa Data só avança e exige a confirmação na etapa Horário', async () => {
    const view = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Aumentar pessoas' }));
    const continueButton = screen.getByRole('button', { name: 'Continuar' });
    fireEvent.submit(continueButton.closest('form')!);
    expect(await screen.findByRole('button', { name: 'Confirmar alteração' })).toBeVisible();
    expect(mocks.change).not.toHaveBeenCalled();
    expect(view.onOpenChange).not.toHaveBeenCalled();
  });

  it('o calendário usa o dia da unidade, incluindo quando já virou o dia em outro fuso', async () => {
    mocks.options.mockImplementation(async input => options({ date: input.date, party_size: input.partySize,
      server_now: '2026-11-22T23:30:00Z', time_zone: 'Asia/Tokyo' }));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Escolher outra data no calendário' }));
    const calendar = await screen.findByRole('grid');
    expect(within(calendar).getByRole('gridcell', { name: '22' })).toBeDisabled();
    expect(within(calendar).getByRole('gridcell', { name: '23' })).toBeEnabled();
    for (let month = 0; month < 12; month++) {
      fireEvent.click(screen.getByRole('button', { name: /próximo mês|next month/i }));
    }
    expect(screen.getByText('novembro 2027')).toBeVisible();
    const lastMonth = screen.getByRole('grid');
    expect(within(lastMonth).getByRole('gridcell', { name: '23' })).toBeEnabled();
    expect(within(lastMonth).getByRole('gridcell', { name: '24' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para as datas' }));
    expect(screen.getByRole('button', { name: 'Mostrar 6 dias anteriores' })).toBeDisabled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('reabrir começa em Data e preenche a versão atual da reserva, sem reaproveitar o rascunho anterior', async () => {
    const view = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Aumentar pessoas' }));
    fireEvent.click(screen.getByRole('button', { name: 'quarta-feira, 25 de novembro de 2026' }));
    await continueToTimes();
    fireEvent.click(screen.getByRole('button', { name: '20:00' }));
    view.rerenderDialog({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const newer = { ...reservation, date: '2026-11-26', time: '20:00', party_size: 4, updated_at: '2026-11-22T14:00:00Z' };
    mocks.options.mockImplementation(async input => options({ date: input.date, party_size: input.partySize, reservation: newer, revision: newer.updated_at }));
    view.rerenderDialog({ open: true, reservation: newer });
    await expectPeople(4);
    expect(screen.getByRole('button', { name: 'quinta-feira, 26 de novembro de 2026' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Confirmar alteração' })).not.toBeInTheDocument();
    await continueToTimes();
    expect(screen.getByRole('button', { name: '20:00' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeDisabled();
    expect(mocks.change).not.toHaveBeenCalled();
  });
});
