import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServiceQueryFeedback from './ServiceQueryFeedback';
import type { FeedbackQuery } from '@/components/QueryFeedback';

const query = (overrides: Partial<FeedbackQuery> = {}): FeedbackQuery => ({ label: 'a fila', data: [], isFetching: false, isError: false, dataUpdatedAt: 1000, refetch: vi.fn().mockResolvedValue({}), ...overrides });
afterEach(cleanup);
describe('fixed header refresh feedback', () => {
  it('reports the last complete timestamp and background fetching without adding a content row', () => {
    const report = vi.fn();
    const view = render(<ServiceQueryFeedback queries={[query(), query({ dataUpdatedAt: 2000 })]} onFreshnessChange={report} />);
    expect(view.container).toBeEmptyDOMElement();
    expect(report).toHaveBeenLastCalledWith({ updatedAt: 1000, fetching: false, hasError: false });
    view.rerender(<ServiceQueryFeedback queries={[query({ isFetching: true }), query({ dataUpdatedAt: 2000 })]} onFreshnessChange={report} />);
    expect(view.container).toBeEmptyDOMElement();
    expect(report).toHaveBeenLastCalledWith({ updatedAt: 1000, fetching: true, hasError: false });
  });
  it('never fabricates a timestamp while any enabled source is unknown', () => {
    const report = vi.fn();
    render(<ServiceQueryFeedback queries={[query(), query({ data: undefined, dataUpdatedAt: 0, isFetching: true })]} onFreshnessChange={report} />);
    expect(report).toHaveBeenLastCalledWith({ updatedAt: null, fetching: true, hasError: false });
    expect(screen.queryByText(/Última atualização/)).not.toBeInTheDocument();
  });
  it('keeps errors and retry but does not duplicate the clock or spinner below the filters', async () => {
    const retry = vi.fn().mockResolvedValue({});
    const unaffected = vi.fn();
    render(<ServiceQueryFeedback queries={[query({ isError: true, refetch: retry }), query({ label: 'as mesas', refetch: unaffected })]} onFreshnessChange={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Mostrando os últimos dados disponíveis.');
    expect(screen.queryByText(/Última atualização/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(unaffected).not.toHaveBeenCalled();
  });
  it('preserves the existing copied standalone feedback when no shared header is present', () => {
    render(<ServiceQueryFeedback queries={[query()]} />);
    expect(screen.getByText(/Última atualização/)).toBeVisible();
  });
  it('keeps the operational timestamp advancing when table configuration has a longer cache lifetime', () => {
    const report = vi.fn();
    const operational = query({ dataUpdatedAt: 3000 });
    render(<ServiceQueryFeedback queries={[operational, query({ label: 'as mesas', dataUpdatedAt: 1000 })]} timestampQueries={[operational]} onFreshnessChange={report} />);
    expect(report).toHaveBeenLastCalledWith({ updatedAt: 3000, fetching: false, hasError: false });
  });
});
