import { render, screen } from '@testing-library/react';
import { CheckCircle2, Users } from 'lucide-react';
import { ReportKpiDelta, ReportKpiStrip, ReportKpiTile } from '@/components/reports/ReportKpiStrip';

describe('ReportKpiStrip', () => {
  it('stretches the last tile when the count would leave a gap', () => {
    const { rerender } = render(
      <ReportKpiStrip aria-label="Indicadores">
        {Array.from({ length: 5 }).map((_, index) => (
          <ReportKpiTile key={index} label={`Indicador ${index}`} value={index} icon={Users} />
        ))}
      </ReportKpiStrip>,
    );

    const strip = screen.getByRole('region', { name: 'Indicadores' });
    expect(strip.className).toContain('[&>*:last-child]:col-span-2');
    expect(strip.className).toContain('xl:grid-cols-5');

    rerender(
      <ReportKpiStrip aria-label="Indicadores">
        {Array.from({ length: 4 }).map((_, index) => (
          <ReportKpiTile key={index} label={`Indicador ${index}`} value={index} icon={Users} />
        ))}
      </ReportKpiStrip>,
    );

    const evenStrip = screen.getByRole('region', { name: 'Indicadores' });
    expect(evenStrip.className).not.toContain('[&>*:last-child]:col-span-2');
    expect(evenStrip.className).toContain('xl:grid-cols-4');
  });

  it('renders label, value and detail of a tile', () => {
    render(
      <ReportKpiTile
        label="Comparecimento"
        value="87,5%"
        detail="120 reservas presentes"
        explanation="Comparecimentos sobre comparecimentos + no-shows."
        icon={CheckCircle2}
      />,
    );

    expect(screen.getByText('Comparecimento')).toBeInTheDocument();
    expect(screen.getByText('87,5%')).toBeInTheDocument();
    expect(screen.getByText('120 reservas presentes')).toBeInTheDocument();
    expect(screen.getByLabelText('Como é calculado: Comparecimento')).toBeInTheDocument();
  });

  it('shows growth as good by default and as bad when lower is better', () => {
    const { rerender } = render(<ReportKpiDelta current={12} previous={9} percentagePoints />);

    const goodDelta = screen.getByText('+3,0 p.p.').parentElement;
    expect(goodDelta?.className).toContain('text-success');

    rerender(<ReportKpiDelta current={12} previous={9} percentagePoints higherIsBetter={false} />);

    const badDelta = screen.getByText('+3,0 p.p.').parentElement;
    expect(badDelta?.className).toContain('text-destructive');
  });

  it('names the compared period for assistive tech', () => {
    render(<ReportKpiDelta current={10} previous={8} comparisonLabel="1 a 31 de agosto" />);

    expect(screen.getByText(/aumento de 25,0%.*comparado com 1 a 31 de agosto/)).toBeInTheDocument();
  });
});
