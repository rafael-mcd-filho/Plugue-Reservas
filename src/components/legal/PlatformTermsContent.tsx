import {
  PLATFORM_LEGAL_ENTITY,
  PLATFORM_TERMS_SECTIONS,
  PLATFORM_TERMS_SUMMARY,
} from '@/lib/platform-terms';

export default function PlatformTermsContent({ companyName }: { companyName?: string }) {
  return (
    <article className="space-y-6 text-sm leading-relaxed text-muted-foreground">
      {companyName && (
        <p className="rounded-lg border border-border bg-muted/30 p-3">
          Estabelecimento desta reserva: <strong className="text-foreground">{companyName}</strong>.
          {' '}Confira também as condições específicas da oferta.
        </p>
      )}
      <section aria-label="Resumo dos termos" className="rounded-xl border border-primary/20 bg-primary-soft/50 p-4">
        <h2 className="text-base font-semibold text-foreground">O essencial antes de reservar</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 marker:text-primary">
          {PLATFORM_TERMS_SUMMARY.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
      {PLATFORM_TERMS_SECTIONS.map((section, index) => (
        <section key={section.id} aria-label={section.title} className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">{index + 1}. {section.title}</h2>
          {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </section>
      ))}
      <p className="border-t border-border pt-4">
        Contato da plataforma:{' '}
        <a className="inline-block break-all py-2 font-medium text-foreground underline underline-offset-4" href={`mailto:${PLATFORM_LEGAL_ENTITY.email}`}>
          {PLATFORM_LEGAL_ENTITY.email}
        </a>
      </p>
    </article>
  );
}
