import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlatformTermsDialog from '@/components/legal/PlatformTermsDialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

afterEach(cleanup);

function ReservationWithTerms() {
  const [reservationOpen, setReservationOpen] = useState(true);
  const [termsOpen, setTermsOpen] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [email, setEmail] = useState('');

  return (
    <Dialog open={reservationOpen} onOpenChange={setReservationOpen}>
      <DialogContent>
        <DialogTitle>Reservar mesa</DialogTitle>
        <DialogDescription>Dados da reserva no Restaurante Teste.</DialogDescription>
        <form onSubmit={event => event.preventDefault()}>
          <label htmlFor="guest-name">Nome completo</label>
          <input id="guest-name" value={guestName} onChange={event => setGuestName(event.target.value)} />
          <label htmlFor="guest-email">E-mail</label>
          <input id="guest-email" type="email" value={email} onChange={event => setEmail(event.target.value)} />
          <button type="button" onClick={() => setTermsOpen(true)}>Termos de Uso</button>
        </form>
        <PlatformTermsDialog open={termsOpen} onOpenChange={setTermsOpen} companyName="Restaurante Teste" />
      </DialogContent>
    </Dialog>
  );
}

describe('PlatformTermsDialog', () => {
  it('não mostra os termos enquanto fechado', () => {
    render(<PlatformTermsDialog open={false} onOpenChange={vi.fn()} companyName="Restaurante Teste" />);
    expect(screen.queryByRole('dialog', { name: 'Termos de Uso' })).not.toBeInTheDocument();
  });

  it('identifica a versão dos termos e permite consultar e guardar uma cópia', () => {
    render(<PlatformTermsDialog open onOpenChange={vi.fn()} companyName="Restaurante Teste" />);

    const dialog = screen.getByRole('dialog', { name: 'Termos de Uso' });
    expect(within(dialog).getByText(/Versão 1\.0.*Elaborada em 20\/11\/2026/)).toBeVisible();
    expect(within(dialog).getAllByText(/Restaurante Teste/).length).toBeGreaterThan(0);
    const standalone = within(dialog).getByRole('link', { name: /Abrir.*página|Ler.*página|Ver.*página|página completa/i });
    expect(standalone).toHaveAttribute('href', '/termos-de-uso');
    expect(standalone).toHaveAttribute('target', '_blank');
    const copyLink = within(dialog).queryByRole('link', { name: /Salvar cópia/ });
    if (copyLink) {
      expect(copyLink).toHaveAttribute('download');
      const href = copyLink.getAttribute('href') ?? '';
      expect(href).toMatch(/^data:text\/plain;charset=utf-8,/);
      const savedText = decodeURIComponent(href.slice(href.indexOf(',') + 1));
      expect(savedText).toContain('Termos de Uso da Plug Guest');
      expect(savedText).toContain('Versão 1.0 · Elaborada em 20/11/2026');
      expect(savedText).toContain('Restaurante Teste');
      expect(savedText).toMatch(/cancelamento/i);
    } else {
      expect(within(dialog).getByRole('button', { name: /Salvar cópia/ })).toBeVisible();
    }
  });

  it('Voltar à reserva fecha somente os termos e preserva os dados já preenchidos', async () => {
    render(<ReservationWithTerms />);
    fireEvent.change(screen.getByLabelText('Nome completo'), { target: { value: 'Ana Souza' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@example.test' } });
    const trigger = screen.getByRole('button', { name: 'Termos de Uso' });
    trigger.focus();
    fireEvent.click(trigger);

    const terms = screen.getByRole('dialog', { name: 'Termos de Uso' });
    fireEvent.click(within(terms).getByRole('button', { name: 'Voltar à reserva' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termos de Uso' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Reservar mesa' })).toBeVisible();
    expect(screen.getByLabelText('Nome completo')).toHaveValue('Ana Souza');
    expect(screen.getByLabelText('E-mail')).toHaveValue('ana@example.test');
  });

  it('Escape fecha os termos sem fechar o formulário de reserva', async () => {
    render(<ReservationWithTerms />);
    fireEvent.change(screen.getByLabelText('Nome completo'), { target: { value: 'Ana Souza' } });
    const trigger = screen.getByRole('button', { name: 'Termos de Uso' });
    trigger.focus();
    fireEvent.click(trigger);

    const terms = screen.getByRole('dialog', { name: 'Termos de Uso' });
    fireEvent.keyDown(terms, { key: 'Escape', code: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termos de Uso' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Reservar mesa' })).toBeVisible();
    expect(screen.getByLabelText('Nome completo')).toHaveValue('Ana Souza');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
