/**
 * Neutral placeholder shared by the public router and the company query.
 * It deliberately avoids either header style so loading never looks like a
 * temporary switch to the classic theme.
 */
export default function PublicPageSkeleton() {
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-secondary p-6"
      aria-busy="true"
      aria-label="Carregando página do restaurante"
    >
      <div
        className="h-24 w-24 animate-pulse rounded-full bg-[#d9d3c8] motion-reduce:animate-none"
        aria-hidden="true"
      />
    </main>
  );
}
