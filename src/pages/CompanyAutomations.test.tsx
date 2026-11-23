import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CompanyAutomations from './CompanyAutomations';

const flags = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useCompanyFeatures', () => ({ useCompanyFeatureFlags: flags }));
vi.mock('@/hooks/useWhatsAppChannel', () => ({ useWhatsAppChannel: () => ({}) }));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: 'unit-1', companyName: 'Unidade' }) }));
vi.mock('@/components/company/AutomationsTab', () => ({ default: function MockAutomationEditor({ saveBlocked }: { saveBlocked?: boolean }) {
  const [draft, setDraft] = useState('');
  return <div data-testid="automation-editor"><input aria-label="Rascunho" value={draft} onChange={(event) => setDraft(event.target.value)} /><button disabled={saveBlocked}>Salvar rascunho</button></div>;
} }));
afterEach(cleanup);

describe('CompanyAutomations feature access', () => {
  it('requires a successful feature read even if cached access was previously enabled', () => {
    const refetch = vi.fn();
    flags.mockReturnValue({ data: { features: { whatsapp_integration: true } }, isError: true, refetch });
    render(<CompanyAutomations />);
    expect(screen.queryByTestId('automation-editor')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível verificar o acesso');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('keeps a paused first feature read pending instead of claiming the feature is disabled', () => {
    flags.mockReturnValue({ data: undefined, isLoading: false, isPending: true });
    render(<CompanyAutomations />);
    expect(screen.queryByTestId('automation-editor')).not.toBeInTheDocument();
    expect(screen.queryByText(/está desabilitada/)).not.toBeInTheDocument();
  });

  it('opens automations only with successfully enabled access', () => {
    flags.mockReturnValue({ data: { features: { whatsapp_integration: true } }, isError: false, isPending: false });
    render(<CompanyAutomations />);
    expect(screen.getByTestId('automation-editor')).toBeInTheDocument();
  });

  it('retains an authorized editor draft while hiding it and blocking saves after a failed access refresh', () => {
    flags.mockReturnValue({ data: { features: { whatsapp_integration: true } }, isError: false, isPending: false });
    const { rerender } = render(<CompanyAutomations />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Rascunho' }), { target: { value: 'Mensagem em edição' } });
    flags.mockReturnValue({ data: { features: { whatsapp_integration: true } }, isError: true, isPending: false, refetch: vi.fn() });
    rerender(<CompanyAutomations />);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível verificar');
    expect(screen.getByTestId('automation-editor')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Salvar rascunho', hidden: true })).toBeDisabled();
    flags.mockReturnValue({ data: { features: { whatsapp_integration: true } }, isError: false, isPending: false });
    rerender(<CompanyAutomations />);
    expect(screen.getByRole('textbox', { name: 'Rascunho' })).toHaveValue('Mensagem em edição');
  });
});
