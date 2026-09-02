import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "..", "..");

const bootstrap = String.raw`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;

  CREATE TABLE public.companies (
    id uuid PRIMARY KEY
  );

  CREATE TABLE public.tracking_sessions (
    id uuid PRIMARY KEY,
    anonymous_id text,
    first_page_url text,
    last_page_url text,
    referrer text,
    fbp text,
    fbc text,
    fbclid text
  );

  CREATE TABLE public.tracking_journeys (
    id uuid PRIMARY KEY
  );

  CREATE TABLE public.tracking_events (
    id uuid PRIMARY KEY
  );

  CREATE TABLE public.reservations (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES public.companies(id),
    origin_tracking_session_id uuid REFERENCES public.tracking_sessions(id),
    origin_tracking_journey_id uuid REFERENCES public.tracking_journeys(id),
    origin_anonymous_id text,
    visitor_id text,
    attribution_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    origin_fbp text,
    origin_fbc text,
    party_size integer NOT NULL,
    date date NOT NULL,
    time time NOT NULL,
    status text NOT NULL
  );

  CREATE TABLE public.company_tracking_settings (
    company_id uuid PRIMARY KEY REFERENCES public.companies(id),
    capi_enabled boolean NOT NULL DEFAULT false,
    pixel_id text,
    access_token text,
    send_page_view boolean NOT NULL DEFAULT false,
    send_initiate_checkout boolean NOT NULL DEFAULT true,
    send_lead boolean NOT NULL DEFAULT true,
    send_schedule boolean NOT NULL DEFAULT false
  );

  CREATE TABLE public.meta_event_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    reservation_id uuid REFERENCES public.reservations(id),
    journey_id uuid REFERENCES public.tracking_journeys(id),
    tracking_event_id uuid REFERENCES public.tracking_events(id),
    event_name text NOT NULL,
    meta_event_name text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb
  );

  CREATE UNIQUE INDEX idx_meta_event_queue_reservation_event_unique
  ON public.meta_event_queue(reservation_id, event_name);

  CREATE UNIQUE INDEX idx_meta_event_queue_tracking_event_unique
  ON public.meta_event_queue(tracking_event_id, event_name);

  INSERT INTO public.companies (id)
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

  INSERT INTO public.tracking_sessions (id, anonymous_id)
  VALUES (
    '20000000-0000-4000-8000-000000000001',
    'visitor-regression'
  );

  INSERT INTO public.tracking_journeys (id)
  VALUES ('30000000-0000-4000-8000-000000000001');

  INSERT INTO public.tracking_events (id)
  VALUES
    ('40000000-0000-4000-8000-000000000001'),
    ('40000000-0000-4000-8000-000000000002');

  INSERT INTO public.reservations (
    id,
    company_id,
    origin_tracking_session_id,
    origin_tracking_journey_id,
    origin_anonymous_id,
    visitor_id,
    party_size,
    date,
    time,
    status
  )
  VALUES (
    '50000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'visitor-regression',
    'visitor-regression',
    2,
    DATE '2026-09-03',
    TIME '19:00',
    'confirmed'
  );

  INSERT INTO public.company_tracking_settings (
    company_id,
    capi_enabled,
    pixel_id,
    access_token,
    send_lead
  )
  VALUES (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    true,
    'pixel-regression',
    'token-regression',
    true
  );
`;

const database = new PGlite();

try {
  const migration = await readFile(
    join(
      repositoryRoot,
      "supabase",
      "migrations",
      "20260902120000_fix_meta_queue_reservation_link_conflict.sql",
    ),
    "utf8",
  );
  const regression = await readFile(
    join(currentDirectory, "meta_event_queue_reservation_link_regression.sql"),
    "utf8",
  );

  await database.exec(bootstrap);
  await database.exec(migration);
  await database.exec(regression);
  console.log("Meta event queue reservation link regression passed.");
} finally {
  await database.close();
}
