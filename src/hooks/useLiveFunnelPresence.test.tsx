import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveFunnelPresence } from '@/hooks/useLiveFunnelPresence';

const useQueryMock = vi.hoisted(() => vi.fn(() => ({ data: undefined })));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

describe('useLiveFunnelPresence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('não consulta a agregação global quando nenhuma empresa foi escolhida', () => {
    renderHook(() => useLiveFunnelPresence());

    expect(useQueryMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('habilita a consulta apenas quando existe uma empresa definida', () => {
    renderHook(() => useLiveFunnelPresence('company-1'));

    expect(useQueryMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});
