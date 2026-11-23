import { useEffect } from 'react';
import PlatformTermsContent from '@/components/legal/PlatformTermsContent';
import {
  getPlatformTermsText,
  PLATFORM_TERMS_DATE,
  PLATFORM_TERMS_FILENAME,
  PLATFORM_TERMS_VERSION,
} from '@/lib/platform-terms';

export default function PlatformTerms() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Termos de Uso | Plug Guest';
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <a href="/" className="inline-flex min-h-11 items-center font-semibold tracking-tight" translate="no">Plug Guest</a>
          <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(getPlatformTermsText())}`} download={PLATFORM_TERMS_FILENAME} className="inline-flex min-h-11 items-center py-2 text-sm font-medium text-foreground underline underline-offset-4">
            Salvar cópia
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-5 py-8 sm:py-12">
        <div className="space-y-2 border-b border-border pb-6">
          <p className="text-sm font-medium text-primary">Reservas, fila de espera e pagamentos</p>
          <h1 className="text-3xl font-semibold tracking-tight">Termos de Uso</h1>
          <p className="text-sm text-muted-foreground">Versão {PLATFORM_TERMS_VERSION} · Elaborada em {PLATFORM_TERMS_DATE}</p>
        </div>
        <PlatformTermsContent />
      </main>
    </div>
  );
}
