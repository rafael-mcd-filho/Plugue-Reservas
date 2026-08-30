import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import CompanySettings from '@/pages/CompanySettings';

const COMPANY_ROW = {
  description: '<p>Bar do teste</p>',
  logo_url: 'https://cdn.test/logo.png',
  time_zone: 'America/Fortaleza',
  hero_media_urls: ['https://cdn.test/hero-1.png'],
  hero_media_url: 'https://cdn.test/hero-1.png',
  hero_media_type: 'image',
  opening_hours: [{ day: 'Seg', open: '18:00', close: '23:00' }],
  payment_methods: { pix: true, dinheiro: false },
  address: 'Rua Teste, 1',
  phone: '(84) 3333-4444',
  instagram: 'bardoteste',
  whatsapp: '(84) 99999-9999',
  show_public_whatsapp_button: true,
  show_public_sticky_reserve_button: true,
  show_public_reservation_exit_prompt: false,
  public_waitlist_enabled: false,
  google_maps_url: null,
  reservation_duration: 60,
  reservation_slot_interval_minutes: 30,
  max_guests_per_slot: 0,
  public_header_style: 'classic',
  large_party_whatsapp_threshold: 10,
  reservation_late_tolerance_minutes: 10,
};

const db = vi.hoisted(() => ({
  updates: [] as { table: string; payload: Record<string, unknown> }[],
  upserts: [] as { table: string; payload: Record<string, unknown> }[],
  rows: {} as Record<string, unknown>,
  missingColumns: [] as string[],
}));

vi.mock('@/integrations/supabase/client', () => {
  const buildFrom = (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: db.rows[table] ?? null, error: null }),
      }),
    }),
    update: (payload: Record<string, unknown>) => {
      // O payload é reaproveitado entre tentativas, então guardamos uma cópia por chamada.
      db.updates.push({ table, payload: { ...payload } });
      const missingColumn = Object.keys(payload).find((column) => db.missingColumns.includes(column));

      return {
        eq: () => ({
          select: () => ({
            maybeSingle: async () => (missingColumn
              ? {
                data: null,
                error: {
                  code: '42703',
                  message: `column "${missingColumn}" of relation "companies" does not exist`,
                },
              }
              : { data: { id: 'company-1' }, error: null }),
          }),
        }),
      };
    },
    upsert: async (payload: Record<string, unknown>) => {
      db.upserts.push({ table, payload });
      return { error: null };
    },
  });

  return {
    supabase: {
      from: (table: string) => buildFrom(table),
      storage: {
        from: () => ({
          getPublicUrl: () => ({ data: { publicUrl: 'https://cdn.test/' } }),
          remove: async () => ({ error: null }),
        }),
      },
    },
  };
});

vi.mock('@/contexts/CompanySlugContext', () => ({
  useCompanySlug: () => ({
    companyId: 'company-1',
    companyName: 'Bar do Teste',
    slug: 'bar-do-teste',
  }),
}));

vi.mock('@/hooks/useCompanyFeatures', () => ({
  useCompanyFeatureFlags: () => ({
    data: {
      features: {
        custom_public_page: true,
        flow_protection: true,
        active_communication: true,
      },
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/components/company/BlockedDatesTab', () => ({
  default: () => <div data-testid="blocked-dates" />,
}));

vi.mock('@/components/company/ReservationScheduleRulesCard', () => ({
  ReservationScheduleRulesCard: () => <div data-testid="schedule-rules" />,
}));

vi.mock('@/components/ui/rich-text-editor', () => ({
  RichTextEditor: ({ id, value }: { id?: string; value: string }) => (
    <textarea id={id} readOnly value={value} />
  ),
}));

function renderPath(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Link to="/bar-do-teste/admin/configuracoes/empresa">ir para empresa</Link>
        <Link to="/bar-do-teste/admin/configuracoes/agenda">ir para agenda</Link>
        <Routes>
          <Route path="/:slug/admin/configuracoes/:section" element={<CompanySettings />} />
          <Route path="/:slug/admin/configuracoes" element={<CompanySettings />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderSection(section: string) {
  return renderPath(`/bar-do-teste/admin/configuracoes/${section}`);
}

async function saveSection(section: string) {
  renderSection(section);

  const saveButton = await screen.findByRole('button', { name: 'Salvar' });
  fireEvent.click(saveButton);

  await waitFor(() => expect(toast.success).toHaveBeenCalled());
}

function companyUpdates() {
  return db.updates.filter((entry) => entry.table === 'companies');
}

function companyUpdatePayload() {
  const updates = companyUpdates();
  expect(updates).toHaveLength(1);

  const { updated_at: _updatedAt, ...columns } = updates[0].payload;
  return Object.keys(columns).sort();
}

describe('CompanySettings — salvamento por página', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    db.updates.length = 0;
    db.upserts.length = 0;
    db.missingColumns = [];
    db.rows = {
      companies: COMPANY_ROW,
      company_public_notices: null,
      company_nps_configs: { company_id: 'company-1', google_review_url: null },
    };
  });

  it('grava apenas o horário de funcionamento na página Agenda', async () => {
    await saveSection('agenda');

    expect(companyUpdatePayload()).toEqual(['opening_hours']);
    expect(db.upserts).toHaveLength(0);
  });

  it('grava apenas os campos de reserva na página Reservas', async () => {
    await saveSection('reservas');

    expect(companyUpdatePayload()).toEqual([
      'large_party_whatsapp_threshold',
      'max_guests_per_slot',
      'public_reservation_exit_prompt_primary_text',
      'public_reservation_exit_prompt_primary_text_size',
      'public_reservation_exit_prompt_secondary_text',
      'public_reservation_exit_prompt_secondary_text_size',
      'reservation_duration',
      'reservation_late_tolerance_minutes',
      'reservation_slot_interval_minutes',
      'show_public_reservation_exit_prompt',
    ]);
    expect(db.upserts).toHaveLength(0);
  });

  it('grava cadastro, localização e pagamentos na página Empresa', async () => {
    await saveSection('empresa');

    expect(companyUpdatePayload()).toEqual([
      'address',
      'description',
      'google_maps_url',
      'instagram',
      'logo_url',
      'payment_methods',
      'phone',
      'time_zone',
      'whatsapp',
    ]);
    expect(db.upserts.map((entry) => entry.table)).toEqual(['company_nps_configs']);
  });

  it('grava apenas os campos públicos na página Página Pública', async () => {
    await saveSection('pagina-publica');

    expect(companyUpdatePayload()).toEqual([
      'hero_media_type',
      'hero_media_url',
      'hero_media_urls',
      'public_header_style',
      'public_waitlist_enabled',
      'show_public_sticky_reserve_button',
      'show_public_whatsapp_button',
    ]);
  });

  it('marca "Não salvo" ao editar e limpa a marca depois de salvar', async () => {
    renderSection('empresa');

    const address = await screen.findByLabelText('Endereço completo');
    expect(screen.queryByText('Não salvo')).not.toBeInTheDocument();

    fireEvent.change(address, { target: { value: 'Rua Nova, 99' } });
    expect(await screen.findByText('Não salvo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Não salvo')).not.toBeInTheDocument());
  });

  it('volta a esconder a marca quando o valor original é restaurado', async () => {
    renderSection('empresa');

    const address = await screen.findByLabelText('Endereço completo');
    fireEvent.change(address, { target: { value: 'Rua Nova, 99' } });
    expect(await screen.findByText('Não salvo')).toBeInTheDocument();

    fireEvent.change(address, { target: { value: COMPANY_ROW.address } });
    await waitFor(() => expect(screen.queryByText('Não salvo')).not.toBeInTheDocument());
  });

  it('não marca "Não salvo" logo após carregar a página', async () => {
    renderSection('pagina-publica');

    await screen.findByRole('button', { name: 'Salvar' });
    await waitFor(() => expect(screen.getByLabelText('Ativar botão sticky reservar agora')).toBeInTheDocument());
    expect(screen.queryByText('Não salvo')).not.toBeInTheDocument();
  });

  it('mantém a marca escondida após salvar mesmo quando o valor gravado é normalizado', async () => {
    renderSection('empresa');

    // O save grava a URL sem os espaços, então o valor gravado difere do que está no campo.
    const mapsUrl = await screen.findByLabelText('Link do Google Maps (embed)');
    fireEvent.change(mapsUrl, {
      target: { value: '  https://www.google.com/maps/embed?pb=abc  ' },
    });
    expect(await screen.findByText('Não salvo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    const savedPayload = companyUpdates()[0].payload;
    expect(savedPayload.google_maps_url).toBe('https://www.google.com/maps/embed?pb=abc');
    await waitFor(() => expect(screen.queryByText('Não salvo')).not.toBeInTheDocument());
  });

  it('reenvia sem a coluna quando o banco ainda não recebeu a migração', async () => {
    db.missingColumns = ['reservation_slot_interval_minutes'];

    await saveSection('reservas');

    const updates = companyUpdates();
    expect(updates).toHaveLength(2);
    expect(Object.keys(updates[0].payload)).toContain('reservation_slot_interval_minutes');
    expect(Object.keys(updates[1].payload)).not.toContain('reservation_slot_interval_minutes');
    expect(Object.keys(updates[1].payload)).toContain('reservation_duration');
  });

  it('não oferece salvamento global na página Disponibilidade', async () => {
    renderSection('disponibilidade');

    expect(await screen.findByTestId('schedule-rules')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument();
  });

  it('redireciona a rota sem seção para Empresa', async () => {
    renderPath('/bar-do-teste/admin/configuracoes');

    expect(await screen.findByRole('heading', { level: 1, name: 'Empresa' })).toBeInTheDocument();
  });

  it('mantém a página quando o usuário cancela a saída com alterações não salvas', async () => {
    renderSection('empresa');

    const address = await screen.findByLabelText('Endereço completo');
    fireEvent.change(address, { target: { value: 'Rua Nova, 99' } });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    fireEvent.click(screen.getByRole('link', { name: 'ir para agenda' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Empresa' })).toBeInTheDocument();
    expect(screen.getByLabelText('Endereço completo')).toHaveValue('Rua Nova, 99');
  });

  it('descarta alterações não salvas depois que o usuário confirma a saída', async () => {
    renderSection('empresa');

    const address = await screen.findByLabelText('Endereço completo');
    fireEvent.change(address, { target: { value: 'Rua Nova, 99' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('link', { name: 'ir para agenda' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Agenda' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'ir para empresa' }));
    expect(await screen.findByLabelText('Endereço completo')).toHaveValue(COMPANY_ROW.address);
    expect(db.updates).toHaveLength(0);
  });

  it('redireciona a aba antiga ?tab= para a página equivalente', async () => {
    renderPath('/bar-do-teste/admin/configuracoes?tab=public-page');

    expect(await screen.findByRole('heading', { level: 1, name: 'Página Pública' })).toBeInTheDocument();
  });
});
