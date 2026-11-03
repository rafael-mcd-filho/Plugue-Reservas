import { type FormEvent, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type CrmLeadEditErrors,
  type CrmLeadEditValues,
  validateCrmLeadEditValues,
} from '@/lib/crm-lead-edit';
import type { CrmLeadProfile } from '@/lib/crm-lead-profile';
import { normalizePhoneE164 } from '@/lib/phone';
import { PhoneInput } from '@/components/ui/phone-input';

interface LeadEditDialogProps {
  open: boolean;
  lead: CrmLeadProfile | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (values: CrmLeadEditValues) => void | Promise<void>;
}

const EMPTY_VALUES: CrmLeadEditValues = {
  fullName: '',
  phone: '',
  email: '',
  birthdate: '',
};

export default function LeadEditDialog({
  open,
  lead,
  pending = false,
  onOpenChange,
  onSave,
}: LeadEditDialogProps) {
  const [values, setValues] = useState<CrmLeadEditValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<CrmLeadEditErrors>({});
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (!open || !lead) return;

    setValues({
      fullName: lead.guest_name === 'Lead sem nome' ? '' : lead.guest_name,
      phone: normalizePhoneE164(lead.guest_phone),
      email: lead.guest_email ?? '',
      birthdate: lead.guest_birthdate ?? '',
    });
    setErrors({});
  }, [lead, open]);

  const updateValue = (field: keyof CrmLeadEditValues, value: string) => {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));
    setErrors((current) => ({ ...current, [field]: undefined, contact: undefined }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateCrmLeadEditValues(values, today);

    if (Object.keys(result.errors).length > 0) {
      setErrors(result.errors);
      return;
    }

    await onSave(result.normalized);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar lead</DialogTitle>
          <DialogDescription>
            Atualize os dados de contato. O histórico de reservas e presenças será preservado.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <div className="space-y-2">
            <Label htmlFor="lead-edit-name">Nome</Label>
            <Input
              id="lead-edit-name"
              value={values.fullName}
              maxLength={160}
              autoComplete="name"
              aria-invalid={!!errors.fullName}
              aria-describedby={errors.fullName ? 'lead-edit-name-error' : undefined}
              onChange={(event) => updateValue('fullName', event.target.value)}
            />
            {errors.fullName && <p id="lead-edit-name-error" className="text-xs text-destructive">{errors.fullName}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="lead-edit-phone">Telefone</Label>
              <PhoneInput
                id="lead-edit-phone"
                value={values.phone}
                inputMode="tel"
                autoComplete="tel"
                aria-invalid={!!errors.phone || !!errors.contact}
                aria-describedby={errors.phone ? 'lead-edit-phone-error' : undefined}
                onChange={(value) => updateValue('phone', value)}
              />
              {errors.phone && <p id="lead-edit-phone-error" className="text-xs text-destructive">{errors.phone}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="lead-edit-birthdate">Nascimento</Label>
              <Input
                id="lead-edit-birthdate"
                type="date"
                value={values.birthdate}
                max={today}
                aria-invalid={!!errors.birthdate}
                aria-describedby={errors.birthdate ? 'lead-edit-birthdate-error' : undefined}
                onChange={(event) => updateValue('birthdate', event.target.value)}
              />
              {errors.birthdate && <p id="lead-edit-birthdate-error" className="text-xs text-destructive">{errors.birthdate}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="lead-edit-email">E-mail</Label>
            <Input
              id="lead-edit-email"
              type="email"
              value={values.email}
              maxLength={320}
              autoComplete="email"
              placeholder="cliente@exemplo.com"
              aria-invalid={!!errors.email || !!errors.contact}
              aria-describedby={errors.email ? 'lead-edit-email-error' : undefined}
              onChange={(event) => updateValue('email', event.target.value)}
            />
            {errors.email && <p id="lead-edit-email-error" className="text-xs text-destructive">{errors.email}</p>}
            {errors.contact && <p className="text-xs text-destructive">{errors.contact}</p>}
            {!errors.contact && (
              <p className="text-xs text-muted-foreground">Mantenha pelo menos um telefone ou e-mail.</p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || !lead}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              Salvar alterações
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
