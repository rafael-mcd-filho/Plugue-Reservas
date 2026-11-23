import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Guarda um filtro, aba ou página no endereço da tela, para que o link
 * compartilhado e o botão voltar preservem o que estava aberto.
 */
export function useUrlParam(key: string, defaultValue: string) {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? defaultValue;

  const setValue = useCallback((next: string | null, options?: { reset?: string[] }) => {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      if (next === null || next === '' || next === defaultValue) updated.delete(key);
      else updated.set(key, next);
      options?.reset?.forEach((resetKey) => updated.delete(resetKey));
      return updated;
    }, { replace: true });
  }, [defaultValue, key, setParams]);

  return [value, setValue] as const;
}

/** Página numérica no endereço; valores inválidos voltam para 1. */
export function useUrlPage(key = 'pagina') {
  const [raw, setRaw] = useUrlParam(key, '1');
  const parsed = Number.parseInt(raw, 10);
  const page = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  const setPage = useCallback((next: number) => setRaw(String(Math.max(1, next))), [setRaw]);
  return [page, setPage] as const;
}
