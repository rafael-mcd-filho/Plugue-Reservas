import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReservationScheduleRulesCard } from '@/components/company/ReservationScheduleRulesCard';
import type {
  ArchivedReservationScheduleRule,
  ReservationScheduleRule,
  ReservationAvailabilityMode,
} from '@/hooks/useReservationScheduleRules';

const hooks = vi.hoisted(() => ({
  rules: [] as ReservationScheduleRule[],
  archivedRules: [] as ArchivedReservationScheduleRule[],
  usage: null as Map<string, number> | null,
  archive: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@/hooks/useReservationScheduleRules', () => ({
  useReservationScheduleRules: () => ({ data: hooks.rules, isLoading: false }),
  useArchivedReservationScheduleRules: () => ({ data: hooks.archivedRules, isLoading: false }),
  useReservationScheduleRuleUsage: () => ({ data: hooks.usage }),
  useSaveReservationScheduleRule: () => ({ mutate: vi.fn(), mutateAsync: hooks.save, isPending: false }),
  useArchiveReservationScheduleRule: () => ({ mutate: hooks.archive, isPending: false, variables: undefined }),
  useRestoreReservationScheduleRule: () => ({ mutate: hooks.restore, isPending: false, variables: undefined }),
  useDeleteReservationScheduleRule: () => ({ mutate: hooks.remove, isPending: false, variables: undefined }),
}));

const COMPANY_ID = 'company-1';

function makeRule(overrides: Partial<ReservationScheduleRule> = {}): ReservationScheduleRule {
  return {
    id: 'rule-1',
    company_id: COMPANY_ID,
    name: 'Dia dos namorados',
    scope: 'date_specific',
    weekdays: null,
    start_date: '2026-06-12',
    end_date: '2026-06-12',
    enabled: true,
    priority: 100,
    max_party_size_per_reservation: null,
    availability_mode: 'tables',
    publish_at: null,
    default_duration_minutes: null,
    archived_at: null,
    created_at: '2026-05-01T12:00:00.000Z',
    updated_at: '2026-05-01T12:00:00.000Z',
    reservation_schedule_rule_blocks: [],
    reservation_schedule_rule_slots: [],
    ...overrides,
  };
}

function makeSlottedRule(availabilityMode: ReservationAvailabilityMode = 'tables'): ReservationScheduleRule {
  return makeRule({
    name: 'Noite',
    scope: 'weekly',
    start_date: null,
    end_date: null,
    reservation_schedule_rule_blocks: [{
      id: 'block-1',
      rule_id: 'rule-1',
      name: 'Padrão',
      weekdays: [1],
      availability_mode: availabilityMode,
      default_duration_minutes: null,
      sort_order: 10,
      created_at: '2026-05-01T12:00:00.000Z',
      updated_at: '2026-05-01T12:00:00.000Z',
      reservation_schedule_rule_slots: ['18:00', '19:00'].map((time, index) => ({
        id: `slot-${index}`,
        rule_id: 'rule-1',
        block_id: 'block-1',
        time,
        ...(index === 0 ? { is_full: true } : {}),
        sort_order: index * 10,
        duration_minutes: null,
        max_party_size_per_reservation: null,
        max_reservations_per_slot: null,
        max_guests_per_slot: availabilityMode === 'capacity' ? 20 : null,
        created_at: '2026-05-01T12:00:00.000Z',
      })),
    }],
  });
}

describe('ReservationScheduleRulesCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T10:00:00'));
    hooks.rules = [];
    hooks.archivedRules = [];
    hooks.usage = new Map();
    hooks.archive.mockReset();
    hooks.restore.mockReset();
    hooks.remove.mockReset();
    hooks.save.mockReset();
    hooks.save.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['tables', 'capacity'] as const)('carrega e salva o estado lotado por horario em %s', async (mode) => {
    hooks.rules = [makeSlottedRule(mode)];

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    expect(screen.getByText('18:00 · Lotado')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Editar Noite'));

    const firstSlot = screen.getByRole('checkbox', { name: 'Marcar horário 18:00 como lotado' });
    const secondSlot = screen.getByRole('checkbox', { name: 'Marcar horário 19:00 como lotado' });
    expect(screen.getByText('Marque como lotado para manter o horário visível e impedir novas reservas pela página pública.')).toBeInTheDocument();
    expect(firstSlot).toBeChecked();
    expect(secondSlot).not.toBeChecked();

    fireEvent.click(firstSlot);
    fireEvent.click(secondSlot);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Salvar regra' })));

    expect(hooks.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rule-1',
      blocks: [expect.objectContaining({
        availability_mode: mode,
        slots: [
          expect.objectContaining({ time: '18:00', is_full: false }),
          expect.objectContaining({ time: '19:00', is_full: true }),
        ],
      })],
    }));
  });

  it('preserva os horarios lotados ao duplicar a regra', async () => {
    hooks.rules = [makeSlottedRule()];

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    await act(async () => fireEvent.click(screen.getByLabelText('Duplicar Noite')));

    expect(hooks.save).toHaveBeenCalledWith(expect.objectContaining({
      id: undefined,
      name: 'Cópia de Noite',
      enabled: false,
      blocks: [expect.objectContaining({
        slots: [
          expect.objectContaining({ time: '18:00', is_full: true }),
          expect.objectContaining({ time: '19:00', is_full: false }),
        ],
      })],
    }));
  });

  it('mantem a capacidade obrigatoria para reservas manuais mesmo em horario marcado como lotado', async () => {
    const rule = makeSlottedRule('capacity');
    rule.reservation_schedule_rule_blocks[0].reservation_schedule_rule_slots[0].max_guests_per_slot = null;
    hooks.rules = [rule];

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    fireEvent.click(screen.getByLabelText('Editar Noite'));
    expect(screen.getByRole('checkbox', { name: 'Marcar horário 18:00 como lotado' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar regra' }));

    expect(screen.getByText('Informe a capacidade total de todos os horários em "Padrão".')).toBeInTheDocument();
    expect(hooks.save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Capacidade total às 18:00'), { target: { value: '20' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Salvar regra' })));
    expect(hooks.save).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [expect.objectContaining({
        slots: [
          expect.objectContaining({ time: '18:00', is_full: true, max_guests_per_slot: 20 }),
          expect.objectContaining({ time: '19:00', is_full: false, max_guests_per_slot: 20 }),
        ],
      })],
    }));
  });

  it('preserva o estado lotado em regras antigas sem blocos e em blocos duplicados', () => {
    const rule = makeSlottedRule();
    hooks.rules = [{
      ...rule,
      reservation_schedule_rule_blocks: [],
      reservation_schedule_rule_slots: rule.reservation_schedule_rule_blocks[0].reservation_schedule_rule_slots,
    }];

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    expect(screen.getByText('18:00 · Lotado')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Editar Noite'));
    expect(screen.getByRole('checkbox', { name: 'Marcar horário 18:00 como lotado' })).toBeChecked();
    fireEvent.click(screen.getByLabelText('Duplicar bloco Padrão'));

    expect(screen.getByRole('checkbox', { name: 'Marcar horário 18:00 como lotado' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Marcar horário 19:00 como lotado' })).not.toBeChecked();
  });

  it('replica o estado lotado e inicia novos horarios disponiveis', async () => {
    hooks.rules = [makeSlottedRule()];

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    fireEvent.click(screen.getByLabelText('Editar Noite'));
    fireEvent.click(screen.getByLabelText('Replicar configurações do horário 18:00 para os demais'));
    expect(screen.getByRole('checkbox', { name: 'Marcar horário 19:00 como lotado' })).toBeChecked();

    fireEvent.change(screen.getByLabelText('Horário para adicionar no bloco Padrão'), { target: { value: '20:00' } });
    fireEvent.click(screen.getByRole('button', { name: /^Adicionar$/ }));
    expect(screen.getByRole('checkbox', { name: 'Marcar horário 20:00 como lotado' })).not.toBeChecked();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Salvar regra' })));
    expect(hooks.save).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [expect.objectContaining({
        slots: [
          expect.objectContaining({ time: '18:00', is_full: true }),
          expect.objectContaining({ time: '19:00', is_full: true }),
          expect.objectContaining({ time: '20:00', is_full: false }),
        ],
      })],
    }));
  });

  it('agrupa excecoes que ja passaram e nao as anuncia como ativas', () => {
    hooks.rules = [
      makeRule(),
      makeRule({ id: 'rule-2', name: 'Natal', start_date: '2026-12-25', end_date: '2026-12-25' }),
    ];

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);

    expect(screen.getByText('Encerradas')).toBeInTheDocument();
    expect(screen.queryByText('Dia dos namorados')).not.toBeInTheDocument();
    expect(screen.getByText('Natal')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Encerradas'));

    const expiredRule = screen.getByText('Dia dos namorados').closest('article');
    expect(expiredRule).not.toBeNull();
    expect(within(expiredRule as HTMLElement).getByText('Encerrada')).toBeInTheDocument();
  });

  it('resume os limites uma vez quando todos os horarios compartilham o mesmo teto', () => {
    const slots = ['18:00:00', '20:00:00', '22:00:00'].map((time, index) => ({
      id: `slot-${index}`,
      rule_id: 'rule-1',
      block_id: 'block-1',
      time,
      sort_order: index * 10,
      duration_minutes: null,
      max_party_size_per_reservation: 2,
      max_reservations_per_slot: 57,
      max_guests_per_slot: null,
      created_at: '2026-05-01T12:00:00.000Z',
    }));

    hooks.rules = [makeRule({
      start_date: '2026-12-25',
      end_date: '2026-12-25',
      reservation_schedule_rule_blocks: [{
        id: 'block-1',
        rule_id: 'rule-1',
        name: 'Padrão',
        weekdays: null,
        availability_mode: 'tables',
        default_duration_minutes: null,
        sort_order: 10,
        created_at: '2026-05-01T12:00:00.000Z',
        updated_at: '2026-05-01T12:00:00.000Z',
        reservation_schedule_rule_slots: slots,
      }],
    })];

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);

    expect(
      screen.getByText('25 de dez de 2026 · Por mesas · até 2 pessoas · 57 reservas por horário'),
    ).toBeInTheDocument();
    expect(screen.getByText('18:00')).toBeInTheDocument();
    expect(screen.queryByText(/18:00 · até 2 pessoas/)).not.toBeInTheDocument();
  });

  it('oferece exclusao definitiva apenas quando a regra nunca gerou reserva', () => {
    hooks.rules = [makeRule({ start_date: '2026-12-25', end_date: '2026-12-25' })];
    hooks.usage = new Map([['rule-1', 3]]);

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    fireEvent.click(screen.getByLabelText('Arquivar Dia dos namorados'));

    expect(screen.getByText('Arquivar regra?')).toBeInTheDocument();
    expect(screen.getByText(/já gerou 3 reservas/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir definitivamente' })).not.toBeInTheDocument();
  });

  it('exclui de vez a regra sem reservas vinculadas', () => {
    hooks.rules = [makeRule({ start_date: '2026-12-25', end_date: '2026-12-25' })];
    hooks.usage = new Map([['rule-1', 0]]);

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    fireEvent.click(screen.getByLabelText('Arquivar Dia dos namorados'));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir definitivamente' }));

    expect(hooks.remove).toHaveBeenCalledWith({ id: 'rule-1', companyId: COMPANY_ID });
    expect(hooks.archive).not.toHaveBeenCalled();
  });

  it('nao oferece exclusao quando a contagem de reservas nao carregou', () => {
    hooks.rules = [makeRule({ start_date: '2026-12-25', end_date: '2026-12-25' })];
    hooks.usage = null;

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    fireEvent.click(screen.getByLabelText('Arquivar Dia dos namorados'));

    expect(screen.queryByRole('button', { name: 'Excluir definitivamente' })).not.toBeInTheDocument();
  });

  it('lista arquivadas com restauracao', () => {
    hooks.archivedRules = [{
      id: 'rule-9',
      company_id: COMPANY_ID,
      name: 'Dia do hamburguer',
      scope: 'date_specific',
      start_date: '2026-05-28',
      end_date: '2026-05-28',
      enabled: false,
      priority: 100,
      publish_at: null,
      archived_at: '2026-09-01T12:00:00.000Z',
      created_at: '2026-04-01T12:00:00.000Z',
    }];
    hooks.usage = new Map([['rule-9', 2]]);

    render(<ReservationScheduleRulesCard companyId={COMPANY_ID} />);
    fireEvent.click(screen.getByText('Arquivadas'));

    expect(screen.getByText(/arquivada em 01\/09\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/2 reservas no histórico/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Excluir Dia do hamburguer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Restaurar/ }));
    expect(hooks.restore).toHaveBeenCalledWith({ id: 'rule-9', companyId: COMPANY_ID });
  });
});
