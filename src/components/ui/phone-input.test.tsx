import { createRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PhoneInput, type PhoneInputProps } from '@/components/ui/phone-input';
import { isValidPhone } from '@/lib/phone';

// cmdk observes its list height and scrolls the selected option. JSDOM provides
// neither layout API; the browser QA separately exercises the actual methods.
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

function Field({ initialValue = '', ...props }: Omit<PhoneInputProps, 'value' | 'onChange'> & { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  return (
    <form>
      <label htmlFor="phone-qa">Telefone do cliente</label>
      <PhoneInput id="phone-qa" name="phone" value={value} onChange={setValue} {...props} />
      <output data-testid="phone-value">{value}</output>
    </form>
  );
}

describe('PhoneInput', () => {
  it('starts empty with Brazil selected, a visible calling code and native required/label support', () => {
    render(<Field required aria-describedby="phone-help" />);

    const input = screen.getByLabelText('Telefone do cliente');
    expect(input).toHaveAttribute('type', 'tel');
    expect(input).toHaveAttribute('name', 'phone');
    expect(input).toHaveAttribute('aria-describedby', 'phone-help');
    expect(input).toBeRequired();
    expect(input).toHaveValue('');
    expect(input).toBeInvalid();
    expect(screen.getByRole('combobox', { name: /Brasil.*\+55/ })).toHaveTextContent('+55');
  });

  it('keeps partial input and accepts a pasted national Brazilian number without losing its DDD', () => {
    render(<Field required />);
    const input = screen.getByLabelText('Telefone do cliente');

    fireEvent.change(input, { target: { value: '11' } });
    expect(screen.getByTestId('phone-value')).toHaveTextContent('+5511');
    fireEvent.change(input, { target: { value: '(11) 99876-5432' } });

    expect(screen.getByTestId('phone-value')).toHaveTextContent('+5511998765432');
    expect(input).toHaveValue('(11) 99876-5432');
    expect(input).toBeValid();
    expect(screen.getByRole('combobox', { name: /Brasil.*\+55/ })).toBeInTheDocument();
  });

  it.each([
    ['+1 407 264 1934', '+14072641934', /Estados Unidos.*\+1/, '(407) 264-1934'],
    ['+1 416 555 0123', '+14165550123', /Canadá.*\+1/, '(416) 555-0123'],
    ['+55 19 99186 2547', '+5519991862547', /Brasil.*\+55/, '(19) 99186-2547'],
  ])('recognizes the country when pasting %s, including countries sharing +1', async (pasted, canonical, countryName, national) => {
    render(<Field />);

    fireEvent.change(screen.getByLabelText('Telefone do cliente'), { target: { value: pasted } });

    expect(screen.getByTestId('phone-value')).toHaveTextContent(canonical);
    expect(await screen.findByRole('combobox', { name: countryName })).toBeInTheDocument();
    expect(screen.getByLabelText('Telefone do cliente')).toHaveValue(national);
    fireEvent.change(screen.getByLabelText('Telefone do cliente'), { target: { value: pasted } });
    expect(screen.getByLabelText('Telefone do cliente')).toHaveValue(national);
  });

  it('loads legacy BR and international existing values and responds to an external edit', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PhoneInput aria-label="Telefone" value="55 (11) 99876-5432" onChange={onChange} />);
    expect(screen.getByLabelText('Telefone')).toHaveValue('(11) 99876-5432');
    expect(screen.getByRole('combobox', { name: /Brasil.*\+55/ })).toBeInTheDocument();

    rerender(<PhoneInput aria-label="Telefone" value="+351912345678" onChange={onChange} />);
    expect(screen.getByLabelText('Telefone')).toHaveValue('912 345 678');
    expect(screen.getByRole('combobox', { name: /Portugal.*\+351/ })).toHaveTextContent('+351');
  });

  it('preserves an invalid international calling code for validation instead of turning it into a valid BR number', () => {
    render(<Field />);
    fireEvent.change(screen.getByLabelText('Telefone do cliente'), { target: { value: '+1 1987654321' } });
    expect(screen.getByTestId('phone-value')).toHaveTextContent('+11987654321');
  });

  it('keeps an unknown explicit calling code invalid through repeated pastes and clearing', () => {
    render(<Field required />);
    const input = screen.getByLabelText('Telefone do cliente');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.change(input, { target: { value: '+99991234567' } });
      expect(screen.getByTestId('phone-value').textContent).toBe('+99991234567');
      expect(isValidPhone(screen.getByTestId('phone-value').textContent)).toBe(false);
      expect(input).toHaveValue('+99991234567');
    }
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('phone-value')).toBeEmptyDOMElement();
    expect(input).toHaveValue('');
    expect(input).toBeInvalid();
  });

  it('forwards the native input reference and disabled/readOnly state', () => {
    const ref = createRef<HTMLInputElement>();
    const { rerender } = render(<PhoneInput ref={ref} aria-label="Telefone" value="+14072641934" onChange={vi.fn()} disabled />);
    expect(ref.current).toBe(screen.getByLabelText('Telefone'));
    expect(ref.current).toHaveValue('(407) 264-1934');
    expect(ref.current).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /Estados Unidos.*\+1/ })).toBeDisabled();

    rerender(<PhoneInput ref={ref} aria-label="Telefone" value="+14072641934" onChange={vi.fn()} readOnly />);
    expect(ref.current).toHaveAttribute('readonly');
    expect(screen.getByRole('combobox', { name: /Estados Unidos.*\+1/ })).toBeDisabled();
  });

  it('changes country through search, accepts its national number and clears to an empty required field', async () => {
    render(<Field required />);
    fireEvent.click(screen.getByRole('combobox', { name: /Brasil/ }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Buscar país ou DDI' }), { target: { value: 'Estados Unidos' } });
    fireEvent.click(await screen.findByRole('option', { name: /Estados Unidos/ }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: /Estados Unidos.*\+1/ })).toHaveTextContent('+1'));
    const input = screen.getByLabelText('Telefone do cliente');
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: '4072641934' } });
    expect(screen.getByTestId('phone-value')).toHaveTextContent('+14072641934');

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('phone-value')).toBeEmptyDOMElement();
    expect(input).toHaveValue('');
    expect(input).toBeInvalid();
    expect(screen.getByRole('combobox', { name: /Estados Unidos.*\+1/ })).toBeInTheDocument();
  });
});
