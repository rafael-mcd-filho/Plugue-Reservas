// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const USED_RULE_ID = '00000000-0000-0000-0000-000000000010';
const UNUSED_RULE_ID = '00000000-0000-0000-0000-000000000011';
const ARCHIVED_RULE_ID = '00000000-0000-0000-0000-000000000012';
const RESERVATION_ID = '00000000-0000-0000-0000-000000000020';

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
  CREATE FUNCTION public.has_role(uuid, public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.has_role_in_company(uuid, public.app_role, uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT $2 = 'admin'::public.app_role $$;

  CREATE TABLE public.reservation_schedule_rules (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    name text NOT NULL,
    scope text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    archived_at timestamptz
  );

  CREATE TABLE public.reservations (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    applied_schedule_rule_id uuid REFERENCES public.reservation_schedule_rules(id) ON DELETE SET NULL
  );

  INSERT INTO public.reservation_schedule_rules (id, company_id, name, scope, enabled, archived_at) VALUES
    ('${USED_RULE_ID}', '${COMPANY_ID}', 'Dia dos namorados', 'date_specific', true, NULL),
    ('${UNUSED_RULE_ID}', '${COMPANY_ID}', 'Natal', 'date_specific', true, NULL),
    ('${ARCHIVED_RULE_ID}', '${COMPANY_ID}', 'Dia do hamburguer', 'date_specific', false, '2026-09-01T12:00:00Z');

  INSERT INTO public.reservations (id, company_id, applied_schedule_rule_id) VALUES
    ('${RESERVATION_ID}', '${COMPANY_ID}', '${USED_RULE_ID}');
`;

describe('migration do ciclo de vida das regras de disponibilidade', () => {
  beforeEach(async () => {
    database = new PGlite();
    await database.exec(bootstrapSql);
    const migration = await readFile(resolve(
      'supabase/migrations/20260922120000_reservation_schedule_rule_lifecycle.sql',
    ), 'utf8');
    await database.exec(migration);
  }, 20_000);

  afterEach(async () => {
    await database.close();
  });

  it('conta quantas reservas cada regra ja publicou', async () => {
    const { rows } = await database.query<{ rule_id: string; reservations_count: number }>(`
      SELECT rule_id, reservations_count
      FROM public.get_reservation_schedule_rule_usage('${COMPANY_ID}')
      ORDER BY rule_id
    `);

    expect(rows).toEqual([
      { rule_id: USED_RULE_ID, reservations_count: 1 },
      { rule_id: UNUSED_RULE_ID, reservations_count: 0 },
      { rule_id: ARCHIVED_RULE_ID, reservations_count: 0 },
    ]);
  });

  it('restaura a regra arquivada como rascunho', async () => {
    await database.exec(`SELECT public.restore_reservation_schedule_rule('${ARCHIVED_RULE_ID}')`);

    const { rows } = await database.query<{ archived_at: string | null; enabled: boolean }>(`
      SELECT archived_at, enabled
      FROM public.reservation_schedule_rules
      WHERE id = '${ARCHIVED_RULE_ID}'
    `);

    expect(rows[0]).toEqual({ archived_at: null, enabled: false });
  });

  it('recusa restaurar uma regra que nao esta arquivada', async () => {
    await expect(
      database.exec(`SELECT public.restore_reservation_schedule_rule('${UNUSED_RULE_ID}')`),
    ).rejects.toThrow(/Regra arquivada nao encontrada/);
  });

  it('exclui em definitivo a regra que nunca gerou reserva', async () => {
    await database.exec(`SELECT public.delete_reservation_schedule_rule('${UNUSED_RULE_ID}')`);

    const { rows } = await database.query(`
      SELECT id FROM public.reservation_schedule_rules WHERE id = '${UNUSED_RULE_ID}'
    `);

    expect(rows).toEqual([]);
  });

  it('protege a regra que ja gerou reserva contra exclusao', async () => {
    await expect(
      database.exec(`SELECT public.delete_reservation_schedule_rule('${USED_RULE_ID}')`),
    ).rejects.toThrow(/ja gerou 1 reserva/);

    const { rows } = await database.query<{ applied_schedule_rule_id: string | null }>(`
      SELECT applied_schedule_rule_id FROM public.reservations WHERE id = '${RESERVATION_ID}'
    `);

    expect(rows[0]).toEqual({ applied_schedule_rule_id: USED_RULE_ID });
  });
});
