import { lazy, type ComponentType } from 'react';

const LAZY_RELOAD_PREFIX = 'lazy-reload:';
const LAZY_IMPORT_ERROR_PATTERN = /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|ChunkLoadError/i;

function getLazyReloadKey(scope: string) {
  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  return `${LAZY_RELOAD_PREFIX}${scope}:${path}`;
}

export function clearLazyReloadMarkers() {
  if (typeof window === 'undefined') return;

  for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = window.sessionStorage.key(index);
    if (key?.startsWith(LAZY_RELOAD_PREFIX)) {
      window.sessionStorage.removeItem(key);
    }
  }
}

export function maybeReloadForLazyImportError(error: unknown, scope = 'route') {
  if (typeof window === 'undefined') return false;

  const message = error instanceof Error ? error.message : String(error);
  if (!LAZY_IMPORT_ERROR_PATTERN.test(message)) return false;

  const reloadKey = getLazyReloadKey(scope);
  if (window.sessionStorage.getItem(reloadKey)) return false;

  window.sessionStorage.setItem(reloadKey, '1');
  window.location.reload();
  return true;
}

export function lazyWithReload<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
  scope = 'route',
) {
  return lazy(async () => {
    try {
      const module = await importer();
      clearLazyReloadMarkers();
      return module;
    } catch (error) {
      if (maybeReloadForLazyImportError(error, scope)) {
        return new Promise<never>(() => {});
      }

      throw error;
    }
  });
}

export async function preloadLazyImport<T>(
  importer: () => Promise<T>,
  scope = 'preload',
) {
  try {
    await importer();
    clearLazyReloadMarkers();
  } catch (error) {
    if (!maybeReloadForLazyImportError(error, scope)) {
      console.warn('Lazy preload failed:', error);
    }
  }
}
