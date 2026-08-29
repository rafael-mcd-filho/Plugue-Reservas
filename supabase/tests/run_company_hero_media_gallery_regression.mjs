import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "..", "..");

const bootstrap = String.raw`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;

  CREATE SCHEMA auth;
  CREATE SCHEMA storage;

  CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');

  CREATE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;

  CREATE TABLE public.companies (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    logo_url text,
    description text,
    phone text,
    address text,
    google_maps_url text,
    whatsapp text,
    instagram text,
    opening_hours jsonb,
    payment_methods jsonb,
    reservation_duration integer NOT NULL DEFAULT 30,
    max_guests_per_slot integer,
    status text NOT NULL DEFAULT 'active',
    show_public_whatsapp_button boolean NOT NULL DEFAULT true,
    public_waitlist_enabled boolean NOT NULL DEFAULT false,
    show_public_sticky_reserve_button boolean NOT NULL DEFAULT true,
    show_public_reservation_exit_prompt boolean NOT NULL DEFAULT false,
    public_reservation_exit_prompt_primary_text text,
    public_reservation_exit_prompt_primary_text_size text,
    public_reservation_exit_prompt_secondary_text text,
    public_reservation_exit_prompt_secondary_text_size text,
    large_party_whatsapp_threshold integer NOT NULL DEFAULT 10,
    reservation_late_tolerance_minutes integer NOT NULL DEFAULT 10,
    hero_media_url text,
    hero_media_type text,
    public_header_style text NOT NULL DEFAULT 'classic'
  );

  CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    company_id uuid NOT NULL REFERENCES public.companies(id),
    role public.app_role NOT NULL
  );

  CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND role = _role
    );
  $$;

  CREATE FUNCTION public.company_feature_enabled(_company_id uuid, _feature text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  AS $$ SELECT true; $$;

  CREATE TABLE storage.objects (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bucket_id text NOT NULL,
    name text NOT NULL
  );

  CREATE FUNCTION storage.foldername(_name text)
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
  AS $$ SELECT string_to_array(_name, '/'); $$;

  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT USAGE ON SCHEMA auth, storage, public TO authenticated;
  GRANT SELECT, DELETE ON storage.objects TO authenticated;
  GRANT SELECT ON public.user_roles TO authenticated;

  CREATE POLICY "Public can view system assets"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'system-assets');

  INSERT INTO public.companies (
    id, name, slug, hero_media_url, hero_media_type
  ) VALUES
    (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Legacy image',
      'legacy-image',
      'https://cdn.test/legacy-cover.jpg',
      NULL
    ),
    (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'Legacy video',
      'legacy-video',
      'https://cdn.test/legacy-video.mp4',
      'video'
    );
`;

const database = new PGlite();

try {
  const migration = await readFile(
    join(repositoryRoot, "supabase", "migrations", "20260829120000_add_company_hero_media_gallery.sql"),
    "utf8",
  );
  const regression = await readFile(
    join(currentDirectory, "company_hero_media_gallery_regression.sql"),
    "utf8",
  );

  await database.exec(bootstrap);
  await database.exec(migration);
  await database.exec(regression);
  console.log("Company hero media gallery regression passed.");
} finally {
  await database.close();
}
