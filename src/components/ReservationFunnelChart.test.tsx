import { fireEvent, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: PropsWithChildren) => <div>{children}</div>,
  BarChart: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Bar: ({ children }: PropsWithChildren) => <div>{children}</div>,
  CartesianGrid: () => null,
  Cell: () => null,
  LabelList: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

import ReservationFunnelChart from '@/components/ReservationFunnelChart';

const populatedData = [
  { step: 'page_view' as const, count: 100 },
  { step: 'date_select' as const, count: 80 },
  { step: 'time_select' as const, count: 60 },
  { step: 'form_fill' as const, count: 40 },
  { step: 'completed' as const, count: 20 },
];

describe('ReservationFunnelChart', () => {
  it('continua renderizando quando matchMedia não está disponível', () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });

    try {
      expect(() => render(<ReservationFunnelChart data={populatedData} state="ready" />)).not.toThrow();
      expect(screen.getByRole('img')).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
    }
  });

  it('mostra skeleton no carregamento inicial sem inventar um funil zerado', () => {
    render(<ReservationFunnelChart data={[]} state="loading" />);

    expect(screen.getByRole('status', { name: 'Carregando dados do funil de reservas' })).toBeInTheDocument();
    expect(screen.queryByText(/Taxa de conversão geral/)).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('diferencia erro e permite tentar novamente', () => {
    const onRetry = vi.fn();
    render(
      <ReservationFunnelChart
        data={[]}
        state="error"
        errorMessage="A consulta demorou mais que o esperado."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar o funil');
    expect(screen.getByRole('alert')).toHaveTextContent('A consulta demorou mais que o esperado.');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('só declara vazio depois de uma resposta válida zerada', () => {
    render(<ReservationFunnelChart data={[]} state="valid-empty" />);

    expect(screen.getByText('Nenhuma jornada pública no período')).toBeInTheDocument();
    expect(screen.getByText(/Reservas criadas no painel ou convertidas da fila/)).toBeInTheDocument();
    expect(screen.queryByText(/Taxa de conversão geral/)).not.toBeInTheDocument();
  });

  it('identifica os dados anteriores enquanto atualiza outro período', () => {
    render(
      <ReservationFunnelChart
        data={populatedData}
        state="refreshing"
        isShowingPreviousData
        previousDataLabel="01/07/2026 - 31/07/2026"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Exibindo temporariamente os dados de 01/07/2026 - 31/07/2026',
    );
    expect(screen.getByRole('img')).toHaveAccessibleName(/Página Pública: 100/);
  });

  it('mantém os últimos dados visíveis quando uma atualização falha', () => {
    render(
      <ReservationFunnelChart
        data={populatedData}
        state="stale-error"
        errorMessage="Não foi possível atualizar agora."
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível atualizar agora.');
    expect(screen.getByRole('img')).toHaveAccessibleName(/Conversão geral: 20,0%/);
  });
});
