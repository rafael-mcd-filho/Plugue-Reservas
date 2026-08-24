import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyFeatureRouteGate from '@/components/company/CompanyFeatureRouteGate';

const featureQuery = vi.hoisted(() => ({
  data: undefined as undefined | { features: Record<string, boolean> },
  isLoading: false,
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock('@/contexts/CompanySlugContext', () => ({
  useCompanySlug: () => ({ companyId: 'company-1' }),
}));

vi.mock('@/hooks/useCompanyFeatures', () => ({
  useCompanyFeatureFlags: () => featureQuery,
}));

function renderGate() {
  return render(
    <MemoryRouter initialEntries={['/relatorio']}>
      <Routes>
        <Route
          path="/relatorio"
          element={(
            <CompanyFeatureRouteGate
              requiredCompanyFeature="advanced_reports"
              loadingFallback={<div>Validando recursos...</div>}
            >
              <div>Conteúdo protegido</div>
            </CompanyFeatureRouteGate>
          )}
        />
        <Route path="/acesso-negado" element={<div>Acesso negado</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CompanyFeatureRouteGate', () => {
  beforeEach(() => {
    featureQuery.data = undefined;
    featureQuery.isLoading = false;
    featureQuery.isFetching = false;
    featureQuery.isError = false;
    featureQuery.refetch.mockReset();
  });

  it('does not mount the protected route when feature validation fails and offers retry', () => {
    featureQuery.isError = true;

    renderGate();

    expect(screen.queryByText('Conteúdo protegido')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível validar o acesso');

    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(featureQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when feature validation finishes without data', () => {
    renderGate();

    expect(screen.queryByText('Conteúdo protegido')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('redirects when the feature is explicitly disabled', () => {
    featureQuery.data = { features: { advanced_reports: false } };

    renderGate();

    expect(screen.getByText('Acesso negado')).toBeInTheDocument();
    expect(screen.queryByText('Conteúdo protegido')).not.toBeInTheDocument();
  });

  it('mounts the route only after the required feature is confirmed', () => {
    featureQuery.data = { features: { advanced_reports: true } };

    renderGate();

    expect(screen.getByText('Conteúdo protegido')).toBeInTheDocument();
  });
});
