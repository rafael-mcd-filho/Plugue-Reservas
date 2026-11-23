import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QueryFeedback, { type FeedbackQuery } from './QueryFeedback';

afterEach(cleanup);
const timestamp = new Date('2026-11-21T12:30:00Z').getTime();
const query = (overrides: Partial<FeedbackQuery> = {}): FeedbackQuery => ({
  label: 'as reservas', data: [], isFetching: false, isError: false, dataUpdatedAt: timestamp,
  refetch: vi.fn().mockResolvedValue({}), ...overrides,
});

describe('QueryFeedback', () => {
  it('treats a confirmed empty result as loaded and shows its actual timestamp', () => {
    render(<QueryFeedback queries={[query()]} />);
    expect(screen.getByText(/Última atualização: 21\/11\/2026/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('distinguishes initial failure from a failed update with cached results', () => {
    render(<QueryFeedback queries={[query({ data: undefined, dataUpdatedAt: 0, isError: true }), query({ label: 'as mesas', data: [], isError: true })]} />);
    expect(screen.getByText('Não foi possível carregar as reservas.')).toBeInTheDocument();
    expect(screen.getByText(/Não foi possível atualizar as mesas. Mostrando os últimos dados disponíveis./)).toBeInTheDocument();
    expect(screen.queryByText(/Última atualização/)).not.toBeInTheDocument();
  });

  it('uses the oldest successful timestamp of all required sources', () => {
    render(<QueryFeedback queries={[query({ dataUpdatedAt: timestamp + 3600000 }), query({ label: 'as mesas' })]} />);
    const expected = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
    expect(screen.getByText(`Última atualização: ${expected}`)).toBeInTheDocument();
  });

  it('retries failed sources and does not invent a successful update after a rejected retry', async () => {
    const failed = vi.fn().mockRejectedValue(new Error('offline'));
    const healthy = vi.fn();
    render(<QueryFeedback queries={[query({ isError: true, refetch: failed }), query({ label: 'as mesas', refetch: healthy })]} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' })));
    expect(failed).toHaveBeenCalledOnce();
    expect(healthy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Mostrando os últimos dados disponíveis.');
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('disables retries in flight and clears the error only when query state succeeds', async () => {
    let complete!: () => void;
    const refetch = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const { rerender } = render(<QueryFeedback queries={[query({ data: undefined, dataUpdatedAt: 0, isError: true, refetch })]} />);
    await act(async () => fireEvent.click(screen.getByRole('button')));
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    await act(async () => { complete(); });
    rerender(<QueryFeedback queries={[query({ refetch })]} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Última atualização:');
  });

  it('announces initial loading separately from background refresh', () => {
    const { rerender } = render(<QueryFeedback queries={[query({ data: undefined, isFetching: true, dataUpdatedAt: 0 })]} />);
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    rerender(<QueryFeedback queries={[query({ data: null, isFetching: true })]} />);
    expect(screen.getByText('Atualizando…')).toBeInTheDocument();
  });

  it('identifies an unknown initial result even when the request is paused', () => {
    render(<QueryFeedback queries={[query({ data: undefined, isPending: true, isFetching: false, dataUpdatedAt: 0 })]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Aguardando carregamento…');
    expect(screen.queryByText(/Última atualização:/)).not.toBeInTheDocument();
  });
});
