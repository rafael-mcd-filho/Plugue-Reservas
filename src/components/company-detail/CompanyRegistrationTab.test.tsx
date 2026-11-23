import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Company } from '@/hooks/useCompanies';
import CompanyRegistrationTab from './CompanyRegistrationTab';

const mock = vi.hoisted(() => ({ update: vi.fn(), dirty: vi.fn() }));
vi.mock('@/hooks/useCompanies', () => ({ useUpdateCompany: () => ({ mutateAsync: mock.update, isPending: false }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: vi.fn() } } }));
vi.mock('@/components/ui/phone-input', () => ({
  PhoneInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input aria-label="Telefone" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const company = {
  id: 'company-1',
  name: 'Beco Mágico - Goiânia',
  slug: 'beco-magico-goiania',
  razao_social: 'Beco Magico Goiania LTDA',
  cnpj: '61627630000185',
  phone: '+5562993400067',
  phone_e164: '+5562993400067',
  email: 'contato@exemplo.com',
  logo_url: '',
  responsible_name: 'Gustavo',
  responsible_email: 'responsavel@exemplo.com',
  responsible_phone: null,
  responsible_phone_e164: null,
  status: 'active',
} as unknown as Company;

function renderTab() {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <CompanyRegistrationTab company={company} logoEditable={false} onDirtyChange={mock.dirty} />
    </MemoryRouter>,
  );
}

beforeEach(() => { vi.clearAllMocks(); mock.update.mockResolvedValue(company); });
afterEach(cleanup);

describe('CompanyRegistrationTab', () => {
  it('opens the existing impersonation chooser before entering company settings', () => {
    renderTab();
    expect(screen.getByRole('link', { name: 'Abrir no painel da empresa →' })).toHaveAttribute('href', '/empresas?impersonar=company-1&destino=configuracoes');
  });
  it('warns that the responsible phone is needed for WhatsApp notices', () => {
    renderTab();
    expect(screen.getByText(/não recebe os avisos da plataforma pelo WhatsApp/)).toBeInTheDocument();
  });

  it('keeps the public address locked until the change is requested, with a warning', () => {
    renderTab();
    expect(screen.queryByLabelText('Novo endereço')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar endereço' }));
    fireEvent.change(screen.getByLabelText('Novo endereço'), { target: { value: 'Beco Mágico Centro' } });
    expect(screen.getByLabelText('Novo endereço')).toHaveValue('beco-magico-centro');
    expect(screen.getByRole('alert')).toHaveTextContent('O link antigo para de funcionar.');
    expect(screen.getByText(/1 alteração não salva: endereço da página/)).toBeInTheDocument();
    expect(mock.dirty).toHaveBeenLastCalledWith(true);
  });

  it('refuses an address that belongs to the system', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar endereço' }));
    fireEvent.change(screen.getByLabelText('Novo endereço'), { target: { value: 'financeiro' } });
    expect(screen.getByText('Esse endereço é usado pelo sistema. Escolha outro.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar cadastro' })).toBeDisabled();
  });

  it('saves only the registration fields and discards back to the saved values', async () => {
    renderTab();
    expect(screen.getByRole('button', { name: 'Salvar cadastro' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Razão social'), { target: { value: 'Beco Mágico Goiânia LTDA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar cadastro' }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith(expect.objectContaining({
      id: 'company-1',
      razao_social: 'Beco Mágico Goiânia LTDA',
      slug: 'beco-magico-goiania',
    })));
    const payload = mock.update.mock.calls[0][0];
    expect(payload).not.toHaveProperty('description');
    expect(payload).not.toHaveProperty('opening_hours');
    expect(payload).not.toHaveProperty('google_maps_url');
  });
});
