import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BroadcastsTab from './BroadcastsTab';
import PlugueChatBroadcastsTab from './PlugueChatBroadcastsTab';

const mocks = vi.hoisted(() => ({
  insertRecipients: vi.fn(),
  createPlugueChatBroadcast: vi.fn(),
  candidates: [
    { id: 'legacy', guest_name: 'Ana legada', guest_phone: '(11) 9999-8888', date: '2026-10-01', status: 'confirmed' },
    { id: 'duplicate', guest_name: 'Ana duplicada', guest_phone: '+551199998888', date: '2026-10-02', status: 'confirmed' },
    { id: 'foreign', guest_name: 'John internacional', guest_phone: '+14072641934', date: '2026-10-02', status: 'confirmed' },
    { id: 'invalid', guest_name: 'Contato invalido', guest_phone: '+9991234567', date: '2026-10-02', status: 'confirmed' },
  ],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled?: boolean }) => ({
    data: enabled === false ? undefined : queryKey[0].includes('broadcast-candidates') ? mocks.candidates : [],
    isFetching: false,
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: ({ mutationFn, onSuccess }: { mutationFn: () => Promise<unknown>; onSuccess?: () => void }) => ({
    isPending: false,
    mutate: () => mutationFn().then(() => onSuccess?.()),
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'operator' } }) }));
vi.mock('@/hooks/useImpersonation', () => ({ useImpersonation: () => ({ isImpersonatingCompany: false }) }));
vi.mock('@/hooks/usePlugueChatBroadcasts', () => ({
  usePlugueChatBroadcasts: () => ({ data: [], isLoading: false }),
  useCreatePlugueChatBroadcast: () => ({ mutate: mocks.createPlugueChatBroadcast, isPending: false }),
  useCancelPlugueChatBroadcast: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => ({
      insert: (rows: unknown) => table === 'whatsapp_broadcast_recipients'
        ? mocks.insertRecipients(rows)
        : { select: () => ({ single: async () => ({ data: { id: 'broadcast' }, error: null }) }) },
    }),
    functions: { invoke: vi.fn().mockResolvedValue({}) },
  },
}));

describe('broadcast audiences with historical BR contacts', () => {
  beforeEach(() => {
    mocks.insertRecipients.mockReset().mockResolvedValue({ error: null });
    mocks.createPlugueChatBroadcast.mockReset();
  });

  it.each(['evolution', 'pluguechat_official'] as const)(
    'keeps the legacy contact, deduplicates it and preserves its destination for %s',
    async (channel) => {
      render(channel === 'evolution'
        ? <BroadcastsTab companyId="company" />
        : <PlugueChatBroadcastsTab companyId="company" activeChannel={channel} />);
      fireEvent.click(screen.getAllByRole('button', { name: /^Buscar$/ })[0]);

      expect(screen.getByText('Ana legada')).toBeInTheDocument();
      expect(screen.getByText('John internacional')).toBeInTheDocument();
      expect(screen.queryByText('Ana duplicada')).not.toBeInTheDocument();
      expect(screen.queryByText('Contato invalido')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Ana legada'));
      fireEvent.click(screen.getByText('John internacional'));
      fireEvent.change(screen.getByLabelText('Nome do disparo'), { target: { value: 'Convite' } });
      fireEvent.change(screen.getByLabelText(channel === 'evolution' ? 'Mensagem' : 'Template'), {
        target: { value: channel === 'evolution' ? 'Ola, venha nos visitar' : 'convite' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar envio' }));

      await waitFor(() => {
        const recipients = channel === 'evolution'
          ? mocks.insertRecipients.mock.calls[0]?.[0]
          : mocks.createPlugueChatBroadcast.mock.calls[0]?.[0]?.recipient_leads;
        expect(recipients?.map((row: { phone: string }) => row.phone)).toEqual(['+551199998888', '+14072641934']);
      });
    },
  );
});
