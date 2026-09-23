// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const TABLE_ID = '00000000-0000-0000-0000-000000000002';
const MAP_ID = '00000000-0000-0000-0000-000000000003';

let database: PGlite;

const bootstrapSql = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;

  CREATE TABLE public.restaurant_tables (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    number integer NOT NULL,
    capacity integer NOT NULL,
    section text,
    table_map_id uuid
  );

  INSERT INTO public.restaurant_tables (
    id, company_id, number, capacity, section, table_map_id
  ) VALUES (
    '${TABLE_ID}', '${COMPANY_ID}', 7, 4, 'Salao', '${MAP_ID}'
  );

  CREATE FUNCTION public.get_public_reservation_schedule(uuid, date)
  RETURNS TABLE (
    source text,
    rule_id uuid,
    rule_name text,
    block_id uuid,
    block_name text,
    slots jsonb,
    max_party_size_per_reservation integer,
    availability_mode text,
    publish_at timestamptz,
    default_duration_minutes integer
  )
  LANGUAGE sql STABLE AS $$
    SELECT
      'default'::text,
      NULL::uuid,
      NULL::text,
      NULL::uuid,
      NULL::text,
      '["18:00", "19:00"]'::jsonb,
      8,
      'tables'::text,
      NULL::timestamptz,
      60
  $$;

  CREATE FUNCTION public.get_public_reservation_availability(uuid, date, integer)
  RETURNS TABLE (
    time_slot time,
    available boolean,
    unavailable_reason text,
    total_tables integer,
    occupied_tables integer,
    available_tables integer,
    total_guests integer,
    reservation_count integer,
    max_party_size_per_reservation integer,
    max_reservations_per_slot integer,
    availability_mode text,
    duration_minutes integer,
    max_guests_per_slot integer
  )
  LANGUAGE sql STABLE AS $$
    SELECT *
    FROM (VALUES
      ('18:00'::time, true, NULL::text, 2, 0, 2, 0, 0, 8, NULL::integer, 'tables'::text, 60, NULL::integer),
      ('19:00'::time, false, 'no_table'::text, 2, 2, 0, 8, 2, 8, NULL::integer, 'tables'::text, 60, NULL::integer)
    ) AS availability(
      time_slot,
      available,
      unavailable_reason,
      total_tables,
      occupied_tables,
      available_tables,
      total_guests,
      reservation_count,
      max_party_size_per_reservation,
      max_reservations_per_slot,
      availability_mode,
      duration_minutes,
      max_guests_per_slot
    )
  $$;

  CREATE FUNCTION public.get_active_table_map(uuid, timestamptz)
  RETURNS TABLE (
    id uuid,
    name text,
    is_default boolean,
    is_enabled boolean,
    active_from timestamptz,
    active_to timestamptz,
    priority integer
  )
  LANGUAGE sql STABLE AS $$
    SELECT '${MAP_ID}'::uuid, 'Principal'::text, true, true,
      NULL::timestamptz, NULL::timestamptz, 0
  $$;

  CREATE FUNCTION public.pick_best_fit_reservation_table(
    uuid, date, time, integer, integer, uuid, uuid
  )
  RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT '${TABLE_ID}'::uuid $$;
`;

describe('otimizacao do fluxo publico de reservas', () => {
  beforeEach(async () => {
    database = new PGlite();
    await database.exec(bootstrapSql);
    const migration = await readFile(resolve(
      'supabase/migrations/20260923120000_optimize_public_reservation_flow.sql',
    ), 'utf8');
    await database.exec(migration);
    await database.exec(migration);
  }, 20_000);

  afterEach(async () => {
    await database.close();
  });

  it('retorna uma janela inteira de agendas em uma chamada', async () => {
    const { rows } = await database.query<{
      reservation_date: string;
      slots: string[];
    }>(`
      SELECT reservation_date::text AS reservation_date, slots
      FROM public.get_public_reservation_schedule_range(
        '${COMPANY_ID}', '2026-09-23', '2026-09-25'
      )
    `);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      reservation_date: '2026-09-23',
      slots: ['18:00', '19:00'],
    });
  });

  it('retorna agenda, disponibilidade e mesa recomendada juntas', async () => {
    const { rows } = await database.query<{
      time_slot: string;
      available: boolean;
      recommended_table_id: string | null;
      recommended_table_number: number | null;
    }>(`
      SELECT time_slot, available, recommended_table_id, recommended_table_number
      FROM public.get_public_reservation_booking_context(
        '${COMPANY_ID}', '2026-09-23', 2
      )
      ORDER BY time_slot
    `);

    expect(rows).toEqual([
      {
        time_slot: '18:00:00',
        available: true,
        recommended_table_id: TABLE_ID,
        recommended_table_number: 7,
      },
      {
        time_slot: '19:00:00',
        available: false,
        recommended_table_id: null,
        recommended_table_number: null,
      },
    ]);
  });
});
