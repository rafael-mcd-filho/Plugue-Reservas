// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const MAP_ID = '00000000-0000-0000-0000-000000000003';
const RESERVATION_ID = '00000000-0000-0000-0000-000000000010';
const SECOND_RESERVATION_ID = '00000000-0000-0000-0000-000000000011';
const TABLE_IDS = [
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000102',
  '00000000-0000-0000-0000-000000000103',
  '00000000-0000-0000-0000-000000000104',
];

let database: PGlite;

const bootstrapSql = `
  SET check_function_bodies = off;
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator', 'user');

  CREATE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT '${USER_ID}'::uuid $$;
  CREATE FUNCTION public.has_company_panel_permission(uuid, uuid, text) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.has_role(uuid, public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.has_role_in_company(uuid, public.app_role, uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.is_reservation_occupying_capacity(uuid, text, timestamptz) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT $2 NOT IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled') $$;
  CREATE FUNCTION public.resolve_reservation_slot_duration(uuid, date, time) RETURNS integer
  LANGUAGE sql STABLE AS $$ SELECT 180 $$;
  CREATE FUNCTION public.get_reservation_audit_actor_name(uuid, text DEFAULT NULL, boolean DEFAULT false) RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT 'Operador de teste'::text $$;
  CREATE FUNCTION public.get_reservation_audit_actor_role(uuid, uuid, boolean DEFAULT false) RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT 'operator'::text $$;

  CREATE TABLE public.companies (
    id uuid PRIMARY KEY,
    status text NOT NULL DEFAULT 'active',
    reservation_duration integer DEFAULT 180,
    max_guests_per_slot integer DEFAULT 0
  );
  CREATE TABLE public.table_maps (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active'
  );
  CREATE TABLE public.restaurant_tables (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    number integer NOT NULL,
    section text,
    capacity integer NOT NULL,
    table_map_id uuid,
    status text NOT NULL DEFAULT 'available'
  );
  CREATE TABLE public.table_sections (
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL
  );
  CREATE TABLE public.blocked_dates (
    company_id uuid NOT NULL,
    date date NOT NULL,
    all_day boolean NOT NULL DEFAULT false,
    start_time time,
    end_time time
  );
  CREATE TABLE public.reservation_schedule_rule_slots (
    rule_id uuid,
    block_id uuid,
    time time NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    duration_minutes integer,
    max_party_size_per_reservation integer,
    max_reservations_per_slot integer,
    max_guests_per_slot integer
  );
  CREATE TABLE public.reservations (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    table_id uuid,
    guest_name text NOT NULL,
    date date NOT NULL,
    time time NOT NULL,
    party_size integer NOT NULL,
    status text NOT NULL DEFAULT 'confirmed',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    duration_minutes integer,
    created_in_mode text,
    table_assignment_note text
  );
  CREATE TABLE public.reservation_audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_id uuid NOT NULL,
    company_id uuid NOT NULL,
    actor_user_id uuid,
    actor_name text NOT NULL,
    actor_role text NOT NULL,
    actor_source text NOT NULL,
    action text NOT NULL,
    summary text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE FUNCTION public.get_active_table_map(uuid, timestamptz)
  RETURNS TABLE (id uuid, name text)
  LANGUAGE sql STABLE AS $$
    SELECT tm.id, tm.name
    FROM public.table_maps tm
    WHERE tm.company_id = $1 AND tm.status = 'active'
    LIMIT 1
  $$;
  CREATE FUNCTION public.get_public_reservation_schedule(uuid, date)
  RETURNS TABLE (
    source text, rule_id uuid, rule_name text, block_id uuid, block_name text,
    slots jsonb, max_party_size_per_reservation integer, availability_mode text,
    publish_at timestamptz, default_duration_minutes integer
  ) LANGUAGE sql STABLE AS $$
    SELECT
      'default'::text,
      '00000000-0000-0000-0000-000000000201'::uuid,
      'Padrão'::text,
      '00000000-0000-0000-0000-000000000202'::uuid,
      'Noite'::text,
      '["18:30"]'::jsonb,
      20,
      'tables'::text,
      NULL::timestamptz,
      180
  $$;
  CREATE FUNCTION public.pick_best_fit_reservation_table(uuid, date, time, integer, integer, uuid, uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT rt.id
    FROM public.restaurant_tables rt
    WHERE rt.company_id = $1 AND rt.capacity >= $5 AND rt.status = 'available'
    ORDER BY rt.capacity, rt.number
    LIMIT 1
  $$;

  CREATE FUNCTION public.create_public_reservation(jsonb, text DEFAULT 'confirmed')
  RETURNS public.reservations LANGUAGE plpgsql AS $$
  DECLARE result public.reservations%ROWTYPE;
  BEGIN
    RETURN result;
  END;
  $$;

  CREATE FUNCTION public.get_admin_reservation_day_capacity(uuid, date)
  RETURNS TABLE (
    time_slot time, slot_start timestamptz, slot_end timestamptz, slot_label text,
    source text, rule_id uuid, rule_name text, block_id uuid, block_name text,
    availability_mode text, active_table_map_id uuid, active_table_map_name text,
    duration_minutes integer, capacity_limit integer, occupying_guest_count integer,
    arrival_guest_count integer, checked_in_guest_count integer, remaining_capacity integer,
    fill_rate numeric, arrival_reservation_count integer, occupying_reservation_count integer,
    total_tables integer, occupied_tables integer, available_tables integer,
    unassigned_reservation_count integer, reservation_limit integer, blocked boolean,
    configuration_issue text, status text, reservations jsonb
  ) LANGUAGE sql STABLE AS $$
    SELECT
      '18:30'::time,
      ($2 + '18:30'::time)::timestamptz,
      ($2 + '21:30'::time)::timestamptz,
      '18:30 - 21:30'::text,
      'default'::text,
      '00000000-0000-0000-0000-000000000201'::uuid,
      'Padrão'::text,
      '00000000-0000-0000-0000-000000000202'::uuid,
      'Noite'::text,
      'tables'::text,
      '${MAP_ID}'::uuid,
      'Principal'::text,
      180,
      42,
      40,
      0,
      0,
      2,
      95.24::numeric,
      0,
      1,
      4,
      1,
      3,
      0,
      NULL::integer,
      false,
      NULL::text,
      'available'::text,
      jsonb_build_array(jsonb_build_object('id', '${RESERVATION_ID}', 'party_size', 40))
  $$;

  INSERT INTO public.companies (id) VALUES ('${COMPANY_ID}');
  INSERT INTO public.table_maps (id, company_id, name) VALUES ('${MAP_ID}', '${COMPANY_ID}', 'Principal');
  INSERT INTO public.table_sections (company_id, code, name) VALUES ('${COMPANY_ID}', 'SALAO', 'Salão');
  INSERT INTO public.reservation_schedule_rule_slots (
    rule_id, block_id, time, duration_minutes, max_party_size_per_reservation
  ) VALUES (
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000202',
    '18:30', 180, 20
  );
  INSERT INTO public.restaurant_tables (id, company_id, number, section, capacity, table_map_id) VALUES
    ('${TABLE_IDS[0]}', '${COMPANY_ID}', 1, 'SALAO', 10, '${MAP_ID}'),
    ('${TABLE_IDS[1]}', '${COMPANY_ID}', 2, 'SALAO', 10, '${MAP_ID}'),
    ('${TABLE_IDS[2]}', '${COMPANY_ID}', 3, 'SALAO', 10, '${MAP_ID}'),
    ('${TABLE_IDS[3]}', '${COMPANY_ID}', 4, 'SALAO', 12, '${MAP_ID}');
  INSERT INTO public.reservations (
    id, company_id, table_id, guest_name, date, time, party_size, duration_minutes, created_in_mode
  ) VALUES
    ('${RESERVATION_ID}', '${COMPANY_ID}', '${TABLE_IDS[0]}', 'Grupo grande', '2026-09-19', '18:00', 40, 180, 'tables'),
    ('${SECOND_RESERVATION_ID}', '${COMPANY_ID}', NULL, 'Outro grupo', '2026-09-19', '18:30', 2, 30, 'tables');
`;

describe('migration de atribuição multi-mesa', () => {
  beforeEach(async () => {
    database = new PGlite();
    await database.exec(bootstrapSql);
    const migration = await readFile(resolve(
      'supabase/migrations/20260919120000_add_multi_table_reservation_assignments.sql',
    ), 'utf8');
    await database.exec(migration);
  }, 20_000);

  afterEach(async () => {
    await database.close();
  });

  it('faz backfill da mesa singular existente', async () => {
    const { rows } = await database.query(`
      SELECT reservation_id, table_id, sort_order, capacity_at_assignment
      FROM public.reservation_table_assignments
      WHERE reservation_id = '${RESERVATION_ID}'
    `);

    expect(rows).toEqual([{
      reservation_id: RESERVATION_ID,
      table_id: TABLE_IDS[0],
      sort_order: 0,
      capacity_at_assignment: 10,
    }]);
  });

  it('atribui quatro mesas atomicamente e bloqueia todas no horário sobreposto', async () => {
    const selectedIds = TABLE_IDS.map((id) => `'${id}'`).join(', ');
    const { rows } = await database.query(`
      SELECT *
      FROM public.assign_reservation_tables(
        '${RESERVATION_ID}', ARRAY[${selectedIds}]::uuid[], false, NULL
      )
    `);

    expect(rows[0]).toMatchObject({
      reservation_id: RESERVATION_ID,
      primary_table_id: TABLE_IDS[0],
      assigned_capacity: 42,
      party_size: 40,
      assignment_state: 'assigned',
    });

    const audit = await database.query(`
      SELECT summary, details
      FROM public.reservation_audit_logs
      WHERE reservation_id = '${RESERVATION_ID}'
      ORDER BY id
    `);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      summary: 'Mesas da reserva atualizadas',
      details: {
        changes: {
          table_ids: {
            old: [TABLE_IDS[0]],
            new: TABLE_IDS,
          },
        },
      },
    });

    const occupied = await database.query(`
      SELECT public.get_occupied_table_ids(
        '${COMPANY_ID}', '2026-09-19'::date, '18:30'::time
      ) AS ids
    `);
    expect(new Set((occupied.rows[0] as { ids: string[] }).ids)).toEqual(new Set(TABLE_IDS));

    await expect(database.query(`
      SELECT *
      FROM public.assign_reservation_tables(
        '${SECOND_RESERVATION_ID}', ARRAY['${TABLE_IDS[3]}']::uuid[], false, NULL
      )
    `)).rejects.toThrow(/ocupada neste horario/i);

    const unchanged = await database.query(`
      SELECT count(*)::integer AS count
      FROM public.reservation_table_assignments
      WHERE reservation_id = '${SECOND_RESERVATION_ID}'
    `);
    expect(unchanged.rows).toEqual([{ count: 0 }]);
  });

  it('não multiplica pessoas e bloqueia as mesas inteiras na disponibilidade pública', async () => {
    const selectedIds = TABLE_IDS.map((id) => `'${id}'`).join(', ');
    await database.exec(`
      UPDATE public.reservations
      SET status = 'cancelled'
      WHERE id = '${SECOND_RESERVATION_ID}';

      SELECT *
      FROM public.assign_reservation_tables(
        '${RESERVATION_ID}', ARRAY[${selectedIds}]::uuid[], false, NULL
      );
    `);

    const { rows } = await database.query(`
      SELECT
        available,
        unavailable_reason,
        total_tables,
        occupied_tables,
        available_tables,
        total_guests
      FROM public.get_public_reservation_availability(
        '${COMPANY_ID}', '2026-09-19'::date, 2
      )
      WHERE time_slot = '18:30'::time
    `);

    expect(rows).toEqual([{
      available: false,
      unavailable_reason: 'no_table',
      total_tables: 4,
      occupied_tables: 4,
      available_tables: 0,
      total_guests: 40,
    }]);
  });

  it('enriquece a capacidade administrativa sem duplicar a reserva', async () => {
    const selectedIds = TABLE_IDS.map((id) => `'${id}'`).join(', ');
    await database.query(`
      SELECT *
      FROM public.assign_reservation_tables(
        '${RESERVATION_ID}', ARRAY[${selectedIds}]::uuid[], false, NULL
      )
    `);

    const { rows } = await database.query(`
      SELECT
        occupying_guest_count,
        occupying_reservation_count,
        occupied_tables,
        available_tables,
        reservations
      FROM public.get_admin_reservation_day_capacity_with_tables(
        '${COMPANY_ID}', '2026-09-19'::date
      )
    `);
    const result = rows[0] as {
      occupying_guest_count: number;
      occupying_reservation_count: number;
      occupied_tables: number;
      available_tables: number;
      reservations: Array<Record<string, unknown>>;
    };

    expect(result.occupying_guest_count).toBe(40);
    expect(result.occupying_reservation_count).toBe(1);
    expect(result.occupied_tables).toBe(4);
    expect(result.available_tables).toBe(0);
    expect(result.reservations).toHaveLength(1);
    expect(result.reservations[0]).toMatchObject({
      id: RESERVATION_ID,
      party_size: 40,
      assigned_table_count: 4,
      assigned_capacity: 42,
    });
    expect(result.reservations[0].table_assignments).toHaveLength(4);
  });

  it('mantém escritas singulares legadas sincronizadas', async () => {
    await database.exec(`
      UPDATE public.reservations
      SET table_id = '${TABLE_IDS[2]}'
      WHERE id = '${RESERVATION_ID}'
    `);

    const { rows } = await database.query(`
      SELECT table_id, sort_order
      FROM public.reservation_table_assignments
      WHERE reservation_id = '${RESERVATION_ID}'
    `);
    expect(rows).toEqual([{ table_id: TABLE_IDS[2], sort_order: 0 }]);
  });

  it('descarta mesas secundárias quando data, horário ou quantidade são editados', async () => {
    const selectedIds = TABLE_IDS.map((id) => `'${id}'`).join(', ');
    await database.query(`
      SELECT *
      FROM public.assign_reservation_tables(
        '${RESERVATION_ID}', ARRAY[${selectedIds}]::uuid[], false, NULL
      )
    `);

    await database.exec(`
      UPDATE public.reservations
      SET time = '22:00'
      WHERE id = '${RESERVATION_ID}'
    `);

    const { rows } = await database.query(`
      SELECT table_id, sort_order
      FROM public.reservation_table_assignments
      WHERE reservation_id = '${RESERVATION_ID}'
    `);
    expect(rows).toEqual([{ table_id: TABLE_IDS[0], sort_order: 0 }]);
  });

  it('protege escritas singulares contra uma mesa secundária já ocupada', async () => {
    const selectedIds = TABLE_IDS.map((id) => `'${id}'`).join(', ');
    await database.query(`
      SELECT *
      FROM public.assign_reservation_tables(
        '${RESERVATION_ID}', ARRAY[${selectedIds}]::uuid[], false, NULL
      )
    `);

    await expect(database.exec(`
      INSERT INTO public.reservations (
        id, company_id, table_id, guest_name, date, time, party_size,
        duration_minutes, created_in_mode
      ) VALUES (
        '00000000-0000-0000-0000-000000000012', '${COMPANY_ID}',
        '${TABLE_IDS[3]}', 'Reserva singular', '2026-09-19', '18:30', 2, 30, 'tables'
      )
    `)).rejects.toThrow(/Mesa indisponivel para este horario/i);
  });

  it('mantém reservas por capacidade fora da alocação de mesas', async () => {
    const capacityReservationId = '00000000-0000-0000-0000-000000000013';
    await database.exec(`
      INSERT INTO public.reservations (
        id, company_id, table_id, guest_name, date, time, party_size,
        duration_minutes, created_in_mode
      ) VALUES (
        '${capacityReservationId}', '${COMPANY_ID}', NULL,
        'Reserva por capacidade', '2026-09-19', '22:00', 2, 30, 'capacity'
      )
    `);

    await expect(database.query(`
      SELECT *
      FROM public.assign_reservation_tables(
        '${capacityReservationId}', ARRAY['${TABLE_IDS[0]}']::uuid[], false, NULL
      )
    `)).rejects.toThrow(/Reserva por capacidade nao utiliza mesa/i);
  });

  it('pode ser reaplicada sem renomear as RPCs existentes', async () => {
    const migration = await readFile(resolve(
      'supabase/migrations/20260919120000_add_multi_table_reservation_assignments.sql',
    ), 'utf8');

    await expect(database.exec(migration)).resolves.toBeDefined();
    const functions = await database.query(`
      SELECT
        to_regprocedure('public.create_public_reservation(jsonb,text)') IS NOT NULL AS public_create_exists,
        to_regprocedure('public.get_admin_reservation_day_capacity(uuid,date)') IS NOT NULL AS legacy_admin_exists,
        to_regprocedure('public.get_admin_reservation_day_capacity_with_tables(uuid,date)') IS NOT NULL AS multi_admin_exists
    `);
    expect(functions.rows).toEqual([{
      public_create_exists: true,
      legacy_admin_exists: true,
      multi_admin_exists: true,
    }]);
  });
});
