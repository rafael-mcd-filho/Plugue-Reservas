export function getFirstName(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";

  return text.split(/\s+/)[0] ?? "";
}
