function formatBuiltAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

export default function BuildVersionBadge() {
  const builtAt = formatBuiltAt(__APP_BUILT_AT__);
  const title = `Versao ${__APP_VERSION__} | commit ${__APP_COMMIT__} | build ${builtAt}`;

  return (
    <div
      title={title}
      className="fixed right-3 top-3 z-[10001] rounded-md border border-black/10 bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm backdrop-blur-sm"
    >
      <span className="hidden sm:inline">v{__APP_VERSION__}</span>
      <span className="hidden sm:inline"> · </span>
      <span>{builtAt}</span>
      <span className="hidden md:inline"> · {__APP_COMMIT__}</span>
    </div>
  );
}
