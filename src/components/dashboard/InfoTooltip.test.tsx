import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import InfoTooltip from '@/components/dashboard/InfoTooltip';

describe('InfoTooltip', () => {
  it('opens explanatory content by click in popover mode', () => {
    render(
      <InfoTooltip
        content="Explicação acessível da métrica."
        ariaLabel="Entender a métrica"
        interaction="popover"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Entender a métrica' }));

    expect(screen.getByText('Explicação acessível da métrica.')).toBeVisible();
  });
});
