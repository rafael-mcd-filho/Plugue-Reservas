import { formatKpiDelta } from './kpi-delta';

describe('kpi-delta', () => {
  it('formats growth and drop as a signed percentage', () => {
    expect(formatKpiDelta({ current: 704, previous: 602 })).toMatchObject({
      direction: 'up',
      label: '+16,9%',
    });
    expect(formatKpiDelta({ current: 5, previous: 10 })).toMatchObject({
      direction: 'down',
      label: '−50,0%',
    });
  });

  it('uses percentage points for rate metrics', () => {
    expect(formatKpiDelta({ current: 1.7, previous: 1, percentagePoints: true })).toMatchObject({
      direction: 'up',
      label: '+0,7 p.p.',
    });
  });

  it('reports stability when the difference is negligible', () => {
    expect(formatKpiDelta({ current: 12, previous: 12 })).toMatchObject({ direction: 'flat', label: 'estável' });
    expect(formatKpiDelta({ current: 1.72, previous: 1.7, percentagePoints: true }).direction).toBe('flat');
  });

  it('has no comparison basis when the previous period is zero', () => {
    expect(formatKpiDelta({ current: 9, previous: 0 })).toMatchObject({ direction: 'unknown', label: '—' });
  });

  it('still compares rates that started at zero', () => {
    expect(formatKpiDelta({ current: 2.5, previous: 0, percentagePoints: true })).toMatchObject({
      direction: 'up',
      label: '+2,5 p.p.',
    });
  });

  it('colors growth as unfavorable when lower is better', () => {
    const noShowRose = formatKpiDelta({ current: 12, previous: 9, percentagePoints: true, higherIsBetter: false });
    expect(noShowRose).toMatchObject({ direction: 'up', favorable: false, label: '+3,0 p.p.' });

    const noShowFell = formatKpiDelta({ current: 9, previous: 12, percentagePoints: true, higherIsBetter: false });
    expect(noShowFell).toMatchObject({ direction: 'down', favorable: true });
  });

  it('leaves favorability undefined when there is nothing to compare', () => {
    expect(formatKpiDelta({ current: 12, previous: 12 }).favorable).toBeNull();
    expect(formatKpiDelta({ current: 9, previous: 0 }).favorable).toBeNull();
  });

  it('describes the variation in full for assistive tech', () => {
    expect(formatKpiDelta({ current: 3, previous: 2 }).description)
      .toBe('aumento de 50,0% em relação ao período anterior');
  });
});
