export const DEFAULT_SYSTEM_NAME = 'Plugue Reservas';

const LEGACY_SYSTEM_NAMES = new Set([
  'ReservaFacil',
  'ReservaFácil',
  'PlugGuest',
  'Plug Guest',
]);

export function normalizeSystemName(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || LEGACY_SYSTEM_NAMES.has(trimmed)) {
    return DEFAULT_SYSTEM_NAME;
  }

  return trimmed;
}
