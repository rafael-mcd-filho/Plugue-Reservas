import * as React from 'react';
import PhoneNumberInput, { getCountryCallingCode, type Country } from 'react-phone-number-input/max';
import type { Props as LibraryPhoneInputProps } from 'react-phone-number-input';
import flags from 'react-phone-number-input/flags';
import labels from 'react-phone-number-input/locale/pt.json';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { normalizePhoneE164, parsePhone } from '@/lib/phone';
import { cn } from '@/lib/utils';

type CountryOption = { value?: Country; label: string; divider?: boolean };

// The package's declaration still describes a class, while its runtime uses
// forwardRef to the native input (modules/PhoneInputWithCountry.js).
const PhoneNumberInputWithRef = PhoneNumberInput as unknown as React.ForwardRefExoticComponent<
  LibraryPhoneInputProps<React.ComponentPropsWithoutRef<typeof Input>> & React.RefAttributes<HTMLInputElement>
>;

type NationalNumberInputProps = React.ComponentPropsWithoutRef<typeof Input> & {
  onInternationalValue?: (value: string) => void;
};

// National display keeps the calling code exclusively in the country button.
// Recognize a full international paste before the library's national formatter
// removes its '+', so it can update the country and number together.
const NationalNumberInput = React.forwardRef<HTMLInputElement, NationalNumberInputProps>(
  ({ onInternationalValue, onChange, ...props }, ref) => (
    <Input {...props} ref={ref} onChange={(event) => {
      const text = event.currentTarget.value.trim();
      const international = /^\+[\d\s().-]*$/.test(text)
        ? parsePhone(text)?.number || `+${text.replace(/\D/g, '')}`
        : '';
      if (international && onInternationalValue) {
        onInternationalValue(international);
      } else {
        onChange?.(event);
      }
    }} />
  ),
);
NationalNumberInput.displayName = 'NationalNumberInput';

function CountrySelect({ value, onChange, options, disabled, readOnly }: {
  value?: Country;
  onChange: (value: Country) => void;
  options: CountryOption[];
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((option) => option.value === value);
  const Flag = value ? flags[value] : undefined;
  const callingCode = value ? getCountryCallingCode(value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`País do telefone: ${current?.label ?? 'Selecionar país'}${callingCode ? ` (+${callingCode})` : ''}`}
          disabled={disabled || readOnly}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-l-md border border-r-0 border-input bg-background px-2.5 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {Flag && <span className="block w-5 overflow-hidden rounded-[2px] [&_svg]:block [&_svg]:w-full"><Flag title={current?.label ?? value} /></span>}
          {callingCode && <span className="text-sm tabular-nums">+{callingCode}</span>}
          <ChevronsUpDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(21rem,calc(100vw-2rem))] p-0">
        <Command label="Buscar país ou DDI">
          <CommandInput placeholder="Buscar país ou DDI…" aria-label="Buscar país ou DDI" />
          <CommandList className="max-h-64 overscroll-contain">
            <CommandEmpty>Nenhum país encontrado.</CommandEmpty>
            {options.filter((option) => option.value && !option.divider).map((option) => {
              const country = option.value!;
              const CountryFlag = flags[country];
              const callingCode = getCountryCallingCode(country);
              return (
                <CommandItem key={country} value={`${option.label} ${country} +${callingCode}`} onSelect={() => { onChange(country); setOpen(false); }} className="gap-2.5">
                  {CountryFlag && <span className="w-5 overflow-hidden rounded-[2px] [&_svg]:block [&_svg]:w-full"><CountryFlag title={option.label} /></span>}
                  <span className="flex-1">{option.label}</span>
                  <span className="tabular-nums text-muted-foreground">+{callingCode}</span>
                  <Check className={cn('h-3.5 w-3.5', value === country ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export type PhoneInputProps = Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> & {
  value?: string | null;
  onChange: (value: string) => void;
  defaultCountry?: Country;
};

// Incomplete edits remain in component state; persistence must call
// normalizePhoneE164 and validate instead of truncating or guessing a DDI.
export const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ value, onChange, defaultCountry = 'BR', className, maxLength: _maxLength, ...props }, ref) => (
    <PhoneNumberInputWithRef
      {...props}
      ref={ref}
      value={normalizePhoneE164(value, defaultCountry) || value || undefined}
      onChange={(next) => onChange(next ?? '')}
      defaultCountry={defaultCountry}
      initialValueFormat="national"
      international={false}
      addInternationalOption={false}
      labels={labels}
      countrySelectComponent={CountrySelect}
      inputComponent={NationalNumberInput}
      numberInputProps={{ className: 'min-w-0 rounded-l-none', onInternationalValue: onChange }}
      className={cn('flex w-full items-center', className)}
      autoComplete={props.autoComplete ?? 'tel'}
      inputMode="tel"
    />
  ),
);
PhoneInput.displayName = 'PhoneInput';
