import { useEffect, useState } from 'react';

type DraftScope<T> = {
  companyId: string;
  saved: Record<string, T>;
  drafts: Record<string, T>;
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Keep server refreshes, unsaved fields and company boundaries separate. */
export function useAutomationDrafts<T extends Record<string, unknown>>(
  companyId: string,
  serverState: Record<string, T>,
  canHydrate: boolean,
) {
  const [scope, setScope] = useState<DraftScope<T> | null>(null);

  useEffect(() => {
    if (!canHydrate) return;
    setScope((previous) => {
      if (!previous || previous.companyId !== companyId) {
        return { companyId, saved: serverState, drafts: serverState };
      }
      if (same(previous.saved, serverState)) return previous;

      const drafts: Record<string, T> = {};
      for (const [type, incoming] of Object.entries(serverState)) {
        const saved = previous.saved[type];
        const draft = previous.drafts[type];
        if (!saved || !draft) {
          drafts[type] = incoming;
          continue;
        }
        // Refresh untouched fields without overwriting local edits to other fields.
        drafts[type] = Object.fromEntries(Object.entries(incoming).map(([field, value]) => [
          field, same(draft[field], saved[field]) ? value : draft[field],
        ])) as T;
      }
      return { companyId, saved: serverState, drafts };
    });
  }, [companyId, serverState, canHydrate]);

  const current = scope?.companyId === companyId ? scope : null;
  const states = current?.drafts ?? {};
  const isDirty = (type: string) => !!current && !same(current.drafts[type], current.saved[type]);

  const update = (type: string, patch: Partial<T>) => {
    setScope((previous) => {
      if (previous?.companyId !== companyId || !previous.drafts[type]) return previous;
      return { ...previous, drafts: { ...previous.drafts, [type]: { ...previous.drafts[type], ...patch } } };
    });
  };

  const discard = (type: string) => {
    setScope((previous) => previous?.companyId === companyId
      ? { ...previous, drafts: { ...previous.drafts, [type]: previous.saved[type] } }
      : previous);
  };

  const commit = (type: string, saved: T) => {
    setScope((previous) => previous?.companyId === companyId
      ? { ...previous, saved: { ...previous.saved, [type]: saved } }
      : previous);
  };

  return {
    states,
    ready: !!current,
    isDirty,
    hasUnsavedChanges: !!current && Object.keys(current.drafts).some(isDirty),
    update,
    discard,
    commit,
  };
}
