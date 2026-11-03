import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LeadEditDialog from '@/components/leads/LeadEditDialog';
import type { CrmLeadProfile } from '@/lib/crm-lead-profile';

const lead: CrmLeadProfile = {
  key: 'phone:5511998765432',
  guest_phone: '5511998765432',
  guest_name: 'Maria da Silva',
  guest_email: 'maria@example.com',
  guest_birthdate: '1992-04-18',
  total_reservations: 3,
  lead_created_at: '2026-01-10T12:00:00Z',
  last_reservation_date: '2026-09-01',
  last_reservation_time: '19:00:00',
  stateCode: 'SP',
  stateName: 'São Paulo',
  source: 'reservation_holder',
  importedLeadId: null,
  importedNotes: null,
  importedAt: null,
  importedByUserId: null,
  importFilename: null,
};

describe('LeadEditDialog', () => {
  it('preenche os dados atuais e envia as alterações normalizadas', async () => {
    const onSave = vi.fn();

    render(
      <LeadEditDialog
        open
        lead={lead}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.getByLabelText('Nome')).toHaveValue('Maria da Silva');
    expect(screen.getByLabelText('Telefone')).toHaveValue('(11) 99876-5432');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: '  Maria Souza  ' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: ' MARIA.SOUZA@EXAMPLE.COM ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      fullName: 'Maria Souza',
      phone: '+5511998765432',
      email: 'maria.souza@example.com',
      birthdate: '1992-04-18',
    }));
  });

  it('salva um telefone internacional sem substituir seu DDI', async () => {
    const onSave = vi.fn();
    render(<LeadEditDialog open lead={lead} onOpenChange={vi.fn()} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText('Telefone'), { target: { value: '+1 407 264 1934' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      phone: '+14072641934',
    })));
  });

  it('mantém o formulário aberto e mostra validação quando faltam contatos', () => {
    const onSave = vi.fn();

    render(
      <LeadEditDialog
        open
        lead={{ ...lead, guest_phone: '', guest_email: null }}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    expect(screen.getByText('Informe pelo menos um telefone ou e-mail.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

