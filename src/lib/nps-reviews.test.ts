import {
  computeRatingDistribution,
  computeVisitWeekdayNps,
  computeWeeklyNps,
  escapeLikePattern,
  getEffectiveReviewStatus,
  getNpsAxis,
  getNpsCategory,
  getNpsZone,
} from './nps-reviews';

describe('nps-reviews', () => {
  it('classifica a nota de recomendação', () => {
    expect(getNpsCategory(10)).toBe('promoter');
    expect(getNpsCategory(9)).toBe('promoter');
    expect(getNpsCategory(8)).toBe('passive');
    expect(getNpsCategory(7)).toBe('passive');
    expect(getNpsCategory(6)).toBe('detractor');
    expect(getNpsCategory(0)).toBe('detractor');
  });

  it('lê o NPS pelas zonas de mercado', () => {
    expect(getNpsZone(100)).toMatchObject({ label: 'Zona de excelência', tone: 'success' });
    expect(getNpsZone(75)).toMatchObject({ label: 'Zona de excelência' });
    expect(getNpsZone(60)).toMatchObject({ label: 'Zona de qualidade', tone: 'success' });
    expect(getNpsZone(0)).toMatchObject({ label: 'Zona de aperfeiçoamento', tone: 'warning' });
    expect(getNpsZone(-10)).toMatchObject({ label: 'Zona crítica', tone: 'destructive' });
  });

  it('trata convite pendente vencido como expirado', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(getEffectiveReviewStatus('pending', '2026-09-20T00:00:00Z', now)).toBe('expired');
    expect(getEffectiveReviewStatus('pending', '2026-10-09T00:00:00Z', now)).toBe('pending');
    expect(getEffectiveReviewStatus('expired', '2026-10-09T00:00:00Z', now)).toBe('expired');
    expect(getEffectiveReviewStatus('submitted', '2026-09-20T00:00:00Z', now)).toBe('submitted');
  });

  it('agrupa o NPS pelo dia da visita, não pelo dia da resposta', () => {
    const result = computeVisitWeekdayNps([
      // Visita no sábado, resposta na quarta seguinte.
      { visit_date: '2026-09-19', submitted_at: '2026-09-23T15:00:00Z', nps_category: 'promoter' },
      { visit_date: '2026-09-19', submitted_at: '2026-09-23T16:00:00Z', nps_category: 'detractor' },
      { visit_date: '2026-09-21', submitted_at: '2026-09-22T10:00:00Z', nps_category: 'promoter' },
      { visit_date: null, submitted_at: '2026-09-22T10:00:00Z', nps_category: 'promoter' },
    ]);

    expect(result).toEqual([
      { weekday: 1, label: 'Segunda', nps: 100, responses: 1 },
      { weekday: 6, label: 'Sábado', nps: 0, responses: 2 },
    ]);
  });

  it('deixa semanas sem resposta vazias na evolução', () => {
    const result = computeWeeklyNps(
      [
        { submitted_at: '2026-09-01T12:00:00', nps_category: 'promoter' },
        { submitted_at: '2026-09-15T12:00:00', nps_category: 'detractor' },
      ],
      '2026-09-01',
      '2026-09-20',
    );

    expect(result.map((point) => point.nps)).toEqual([100, null, -100]);
    expect(result.map((point) => point.responses)).toEqual([1, 0, 1]);
  });

  it('ajusta o eixo ao intervalo dos dados com marcas redondas', () => {
    expect(getNpsAxis([80, 100])).toEqual({ domain: [70, 100], ticks: [70, 80, 90, 100] });
    expect(getNpsAxis([-30, 20])).toEqual({ domain: [-50, 50], ticks: [-50, -25, 0, 25, 50] });
    expect(getNpsAxis([-8, 100])).toEqual({ domain: [-50, 100], ticks: [-50, 0, 50, 100] });
    expect(getNpsAxis([])).toEqual({ domain: [-100, 100], ticks: [-100, -50, 0, 50, 100] });
  });

  it('calcula média e distribuição das estrelas', () => {
    const result = computeRatingDistribution(
      [{ food_rating: 5 }, { food_rating: 4 }, { food_rating: null }, { food_rating: 5 }],
      'food_rating',
    );

    expect(result.total).toBe(3);
    expect(result.average).toBeCloseTo(14 / 3);
    expect(result.counts).toEqual([0, 0, 0, 1, 2]);
  });

  it('escapa curingas da busca por nome', () => {
    expect(escapeLikePattern('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
