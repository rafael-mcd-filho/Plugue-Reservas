import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAutomationDrafts } from './useAutomationDrafts';

const first = {
  confirmation: { enabled: false, message: 'Confirmação salva' },
  cancellation: { enabled: false, message: 'Cancelamento salvo' },
};

describe('automation drafts across saved cards and companies', () => {
  it('saving one card leaves another card dirty and restores its latest saved data on discard', () => {
    const { result } = renderHook(() => useAutomationDrafts('company-1', first, true));
    act(() => {
      result.current.update('confirmation', { enabled: true });
      result.current.update('cancellation', { message: 'Cancelamento editado' });
    });
    act(() => result.current.commit('confirmation', result.current.states.confirmation));
    expect(result.current.isDirty('confirmation')).toBe(false);
    expect(result.current.isDirty('cancellation')).toBe(true);
    expect(result.current.hasUnsavedChanges).toBe(true);
    act(() => result.current.discard('cancellation'));
    expect(result.current.states.cancellation.message).toBe('Cancelamento salvo');
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it('rejects callbacks from a previous company while retaining the next company state', () => {
    const { result, rerender } = renderHook(({ companyId }) => useAutomationDrafts(companyId, first, true), { initialProps: { companyId: 'company-1' } });
    const previousCommit = result.current.commit;
    act(() => result.current.update('confirmation', { message: 'Rascunho da unidade 1' }));
    rerender({ companyId: 'company-2' });
    act(() => previousCommit('confirmation', { enabled: true, message: 'Resposta atrasada' }));
    expect(result.current.states.confirmation.message).toBe('Confirmação salva');
    expect(result.current.states.confirmation.enabled).toBe(false);
    expect(result.current.hasUnsavedChanges).toBe(false);
  });
});
