import type { RefObject } from 'react';
import PlatformTermsContent from '@/components/legal/PlatformTermsContent';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  getPlatformTermsText,
  PLATFORM_TERMS_DATE,
  PLATFORM_TERMS_FILENAME,
  PLATFORM_TERMS_PATH,
  PLATFORM_TERMS_VERSION,
} from '@/lib/platform-terms';

interface PlatformTermsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName?: string;
  returnFocusRef?: RefObject<HTMLButtonElement>;
}

export default function PlatformTermsDialog({ open, onOpenChange, companyName, returnFocusRef }: PlatformTermsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[88dvh] sm:max-w-2xl"
        onCloseAutoFocus={event => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-14 text-left">
          <DialogTitle>Termos de Uso</DialogTitle>
          <DialogDescription>Versão {PLATFORM_TERMS_VERSION} · Elaborada em {PLATFORM_TERMS_DATE}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5" tabIndex={0} role="region" aria-label="Conteúdo dos Termos de Uso">
          <PlatformTermsContent companyName={companyName} />
        </div>
        <DialogFooter className="shrink-0 gap-2 border-t border-border px-5 py-3 sm:items-center sm:justify-between sm:space-x-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <a href={PLATFORM_TERMS_PATH} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center py-2 font-medium text-foreground underline underline-offset-4">
              Abrir em outra página
            </a>
            <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(getPlatformTermsText(companyName))}`} download={PLATFORM_TERMS_FILENAME} className="inline-flex min-h-11 items-center py-2 font-medium text-foreground underline underline-offset-4">
              Salvar cópia
            </a>
          </div>
          <Button type="button" onClick={() => onOpenChange(false)}>Voltar à reserva</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
