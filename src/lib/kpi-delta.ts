// Variacao de um KPI contra o periodo anterior, no formato curto que cabe ao
// lado do valor ("+16,9%", "+0,7 p.p."). O texto longo fica no title/leitor de
// tela, nao no card.

export type KpiDeltaDirection = 'up' | 'down' | 'flat' | 'unknown';

export interface KpiDeltaInput {
  current: number;
  previous: number;
  // Metricas em porcentagem variam em pontos percentuais, nao em porcentagem
  // de porcentagem.
  percentagePoints?: boolean;
  // Em no-show, cancelamento e afins, subir e ruim: a seta continua apontando
  // para cima, mas a cor acompanha o que e bom para a operacao.
  higherIsBetter?: boolean;
}

export interface KpiDelta {
  direction: KpiDeltaDirection;
  favorable: boolean | null;
  label: string;
  description: string;
}

const decimalFormatter = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatKpiDelta({
  current,
  previous,
  percentagePoints = false,
  higherIsBetter = true,
}: KpiDeltaInput): KpiDelta {
  const difference = current - previous;

  if (!Number.isFinite(difference) || Math.abs(difference) < 0.05) {
    return {
      direction: 'flat',
      favorable: null,
      label: 'estável',
      description: 'estável em relação ao período anterior',
    };
  }

  if (!percentagePoints && previous === 0) {
    return {
      direction: 'unknown',
      favorable: null,
      label: '—',
      description: 'sem base de comparação no período anterior',
    };
  }

  const magnitude = percentagePoints
    ? `${decimalFormatter.format(Math.abs(difference))} p.p.`
    : `${decimalFormatter.format(Math.abs((difference / previous) * 100))}%`;
  const isPositive = difference > 0;

  return {
    direction: isPositive ? 'up' : 'down',
    favorable: isPositive === higherIsBetter,
    label: `${isPositive ? '+' : '−'}${magnitude}`,
    description: `${isPositive ? 'aumento' : 'queda'} de ${magnitude} em relação ao período anterior`,
  };
}
