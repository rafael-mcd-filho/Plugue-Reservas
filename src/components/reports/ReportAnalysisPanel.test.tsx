import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ReportAnalysisPanel from './ReportAnalysisPanel';

function Location() { return <output data-testid="location">{useLocation().search}</output>; }
describe('Resumo e exploração do relatório', () => {
  it('mostra no máximo três leituras e preserva filtros ao explorar e voltar', () => {
    render(<MemoryRouter initialEntries={['/?period=custom&from=2026-11-01&outcome=no_show']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ReportAnalysisPanel insights={Array.from({ length: 4 }, (_, index) => ({ title: 'Leitura ' + index, detail: 'Base explicitada ' + index }))}><p>Gráficos e registros</p></ReportAnalysisPanel><Location /></MemoryRouter>);
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByText('Leitura 3')).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Explorar dados' }), { button: 0, ctrlKey: false });
    expect(screen.getByText('Gráficos e registros')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('report_view=explore');
    expect(screen.getByTestId('location')).toHaveTextContent('outcome=no_show');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Resumo' }), { button: 0, ctrlKey: false });
    expect(screen.getByText('Leitura 0')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('from=2026-11-01');
    expect(screen.getByTestId('location')).not.toHaveTextContent('report_view');
  });
});
