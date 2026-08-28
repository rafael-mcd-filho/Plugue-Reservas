import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LiveFunnelPanel from '@/components/LiveFunnelPanel';

const stages = [
  { stage: 'page_view' as const, count: 2 },
  { stage: 'date_select' as const, count: 1 },
  { stage: 'time_select' as const, count: 1 },
  { stage: 'form_fill' as const, count: 0 },
  { stage: 'completed' as const, count: 0 },
];

describe('LiveFunnelPanel', () => {
  it('reserves the complete panel while live data is loading', () => {
    render(
      <LiveFunnelPanel
        data={[]}
        totalActive={0}
        windowMinutes={5}
        isLoading
      />,
    );

    expect(screen.getByText('Ao Vivo')).toBeVisible();
    expect(screen.getByRole('status', { name: 'Carregando atividade ao vivo' })).toBeVisible();
    expect(screen.getByLabelText('Página Pública: carregando')).toBeVisible();
    expect(screen.getByLabelText('Reserva Finalizada: carregando')).toBeVisible();
    expect(screen.getAllByText('Carregando…')).toHaveLength(5);
    expect(screen.getByText('Ao Vivo').closest('[aria-busy="true"]')).not.toBeNull();
  });

  it('keeps the full live journey in a compact, accessible strip', () => {
    render(<LiveFunnelPanel data={stages} totalActive={4} windowMinutes={5} />);

    expect(screen.getByText('Ao Vivo')).toBeVisible();
    expect(screen.queryByText('Atividade nos últimos 5 min')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '4 sessões ativas nos últimos 5 minutos' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Etapas das sessões ativas' })).toBeVisible();

    expect(screen.getByLabelText('Página Pública: 2 sessões, 50% do total ativo')).toBeVisible();
    expect(screen.getByLabelText('Seleção de Data: 1 sessão, 25% do total ativo')).toBeVisible();
    expect(screen.getByLabelText('Seleção de Horário: 1 sessão, 25% do total ativo')).toBeVisible();
    expect(screen.getByLabelText('Dados Pessoais: 0 sessões, 0% do total ativo')).toBeVisible();
    expect(screen.getByLabelText('Reserva Finalizada: 0 sessões, 0% do total ativo')).toBeVisible();
  });

  it('uses singular wording for one active session', () => {
    render(
      <LiveFunnelPanel
        data={stages.map((stage, index) => ({ ...stage, count: index === 0 ? 1 : 0 }))}
        totalActive={1}
        windowMinutes={5}
      />,
    );

    expect(screen.getByRole('status', { name: '1 sessão ativa nos últimos 5 minutos' })).toBeVisible();
    expect(screen.getByText('sessão')).toBeVisible();
  });

  it('handles an empty live window without invalid percentages', () => {
    render(
      <LiveFunnelPanel
        data={stages.map((stage) => ({ ...stage, count: 0 }))}
        totalActive={0}
        windowMinutes={5}
      />,
    );

    expect(screen.getByRole('status', { name: '0 sessões ativas nos últimos 5 minutos' })).toBeVisible();
    expect(screen.getAllByText('0% do total')).toHaveLength(5);
  });
});
