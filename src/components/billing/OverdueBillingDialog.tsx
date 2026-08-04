import { AlertTriangle, ArrowRight, CalendarClock, ReceiptText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface OverdueBillingDialogProps {
  open: boolean;
  overdueCount: number;
  overdueTotal: number;
  oldestOverdueDays: number;
  onOpenChange: (open: boolean) => void;
  onViewInvoices: () => void;
}

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export default function OverdueBillingDialog({
  open,
  overdueCount,
  overdueTotal,
  oldestOverdueDays,
  onOpenChange,
  onViewInvoices,
}: OverdueBillingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden border-destructive/25 p-0 sm:max-w-md">
        <div className="border-b border-destructive/15 bg-destructive-soft/70 px-6 pb-5 pt-6">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-destructive/20 bg-background text-destructive shadow-sm">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="text-xl">Pagamento em atraso</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-foreground/70">
              {overdueCount === 1
                ? 'Existe uma mensalidade da Plug Guest aguardando pagamento.'
                : `Existem ${overdueCount} mensalidades da Plug Guest aguardando pagamento.`}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-3 px-6 py-5">
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/25 px-4 py-3">
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <ReceiptText className="h-4 w-4" />
              Total vencido
            </div>
            <span className="font-semibold tabular-nums text-foreground">
              {currencyFormatter.format(overdueTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/25 px-4 py-3">
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <CalendarClock className="h-4 w-4" />
              Maior atraso
            </div>
            <span className="font-semibold tabular-nums text-destructive">
              {oldestOverdueDays} {oldestOverdueDays === 1 ? 'dia' : 'dias'}
            </span>
          </div>
          <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
            O aviso não bloqueia o uso do sistema. Consulte as cobranças para abrir a segunda via ou conferir a atualização do pagamento.
          </p>
        </div>

        <DialogFooter className="border-t border-border bg-muted/20 px-6 py-4 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Lembrar mais tarde
          </Button>
          <Button onClick={onViewInvoices} className="gap-2">
            Ver faturas
            <ArrowRight className="h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
