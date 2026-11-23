import { useEffect, useMemo, useRef, useState } from 'react';
import type { SystemSetting } from '@/hooks/useSettings';

/**
 * Rascunho de campos de system_settings. Uma atualização dos dados vinda do
 * servidor só substitui o rascunho quando não há alteração pendente.
 */
export function useSettingsDraft<K extends string>(settings: SystemSetting[] | undefined, keys: readonly K[]) {
  const saved = useMemo(() => {
    const values = {} as Record<K, string>;
    for (const key of keys) {
      values[key] = settings?.find((setting) => setting.key === key)?.value || '';
    }
    return values;
    // keys é uma lista fixa declarada pelo chamador.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  const [draft, setDraft] = useState<Record<K, string>>(saved);
  const dirty = keys.some((key) => draft[key] !== saved[key]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirtyRef.current) setDraft(saved);
  }, [saved]);

  return {
    saved,
    draft,
    dirty,
    setField: (key: K, value: string) => setDraft((current) => ({ ...current, [key]: value })),
    discard: () => setDraft(saved),
  };
}
