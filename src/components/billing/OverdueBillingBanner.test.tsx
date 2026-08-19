/** @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import OverdueBillingBanner from '@/components/billing/OverdueBillingBanner';

describe('OverdueBillingBanner', () => {
  afterEach(cleanup);

  it('stays hidden when the restricted warning is false', () => {
    render(
      <MemoryRouter>
        <OverdueBillingBanner show={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('warns every company user without exposing financial details', () => {
    const { container } = render(
      <MemoryRouter>
        <OverdueBillingBanner show />
      </MemoryRouter>,
    );

    const warning = screen.getByRole('status');
    expect(warning).toHaveAttribute('aria-live', 'polite');
    expect(warning).toHaveAttribute('aria-atomic', 'true');
    expect(warning).toHaveTextContent('Há faturas vencidas há 6 dias ou mais');
    expect(warning).toHaveTextContent('evitar a suspensão da conta');
    expect(screen.queryByRole('link', { name: /ver faturas/i })).not.toBeInTheDocument();
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('offers the Financeiro shortcut only to users who can open it', () => {
    render(
      <MemoryRouter>
        <OverdueBillingBanner
          show
          invoicesPath="/beco/admin/financeiro"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /ver faturas/i })).toHaveAttribute(
      'href',
      '/beco/admin/financeiro',
    );
  });
});
