BEGIN;

CREATE OR REPLACE FUNCTION public.test_assert(_condition boolean, _message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(_condition, false) THEN
    RAISE EXCEPTION 'hero media gallery regression: %', _message;
  END IF;
END;
$$;

SELECT public.test_assert(
  (SELECT hero_media_urls FROM public.companies WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    = ARRAY['https://cdn.test/legacy-cover.jpg'],
  'legacy image was not backfilled'
);

SELECT public.test_assert(
  (SELECT hero_media_urls FROM public.companies WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    = ARRAY['https://cdn.test/legacy-video.mp4'],
  'legacy video was not backfilled'
);

SELECT public.test_assert(
  (SELECT hero_media_type FROM public.companies WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 'image',
  'image type was not inferred during backfill'
);

SELECT public.test_assert(
  (SELECT attributes.attnotnull
   FROM pg_attribute AS attributes
   WHERE attributes.attrelid = 'public.companies'::regclass
     AND attributes.attname = 'hero_media_urls'
     AND NOT attributes.attisdropped),
  'gallery column is nullable'
);

SELECT public.test_assert(
  (SELECT pg_get_expr(defaults.adbin, defaults.adrelid) = '''{}''::text[]'
   FROM pg_attrdef AS defaults
   JOIN pg_attribute AS attributes
     ON attributes.attrelid = defaults.adrelid
    AND attributes.attnum = defaults.adnum
   WHERE defaults.adrelid = 'public.companies'::regclass
     AND attributes.attname = 'hero_media_urls'),
  'gallery column default is not an empty array'
);

UPDATE public.companies
SET
  hero_media_urls = ARRAY[
    ' https://cdn.test/cover.jpg ',
    '',
    'https://cdn.test/second.jpg'
  ],
  hero_media_type = 'image'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

SELECT public.test_assert(
  (SELECT hero_media_urls FROM public.companies WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    = ARRAY['https://cdn.test/cover.jpg', 'https://cdn.test/second.jpg'],
  'trigger did not normalize ordered image URLs'
);

SELECT public.test_assert(
  (SELECT hero_media_url FROM public.companies WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    = 'https://cdn.test/cover.jpg',
  'legacy URL was not synchronized with the cover'
);

UPDATE public.companies
SET hero_media_url = 'https://cdn.test/legacy-client-replacement.jpg'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

SELECT public.test_assert(
  (SELECT hero_media_urls FROM public.companies WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    = ARRAY['https://cdn.test/legacy-client-replacement.jpg'],
  'legacy writer did not replace the gallery'
);

UPDATE public.companies
SET hero_media_url = NULL
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

SELECT public.test_assert(
  (SELECT hero_media_urls = '{}'::text[] AND hero_media_type IS NULL AND hero_media_url IS NULL
   FROM public.companies
   WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'legacy writer did not clear the gallery consistently'
);

DO $$
BEGIN
  BEGIN
    UPDATE public.companies
    SET
      hero_media_urls = ARRAY['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'],
      hero_media_type = 'image'
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'five-image gallery unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.companies
    SET
      hero_media_urls = ARRAY['1.mp4', '2.mp4'],
      hero_media_type = 'video'
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'two-video gallery unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

ALTER TABLE public.companies DISABLE TRIGGER sync_company_hero_media_gallery;

DO $$
BEGIN
  BEGIN
    UPDATE public.companies
    SET
      hero_media_urls = ARRAY['1.jpg'],
      hero_media_type = NULL,
      hero_media_url = '1.jpg'
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'non-empty gallery without a media type unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.companies
    SET
      hero_media_urls = ARRAY['1.jpg'],
      hero_media_type = 'image',
      hero_media_url = NULL
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'non-empty gallery without a legacy cover unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

ALTER TABLE public.companies ENABLE TRIGGER sync_company_hero_media_gallery;

SELECT public.test_assert(
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'sync_company_hero_media_gallery'
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ),
  'gallery synchronization trigger is absent or disabled'
);

SELECT public.test_assert(
  NOT has_function_privilege('anon', 'public.sync_company_hero_media_gallery()'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.sync_company_hero_media_gallery()'::regprocedure, 'EXECUTE'),
  'internal trigger function has an unsafe EXECUTE grant'
);

SELECT public.test_assert(
  has_function_privilege('anon', 'public.get_public_company_by_slug(text)'::regprocedure, 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.get_public_company_by_slug(text)'::regprocedure, 'EXECUTE'),
  'public company RPC is not callable by its intended roles'
);

SELECT public.test_assert(
  (SELECT provolatile = 's' AND prosecdef
   FROM pg_proc
   WHERE oid = 'public.get_public_company_by_slug(text)'::regprocedure),
  'public company RPC lost STABLE or SECURITY DEFINER'
);

SELECT public.test_assert(
  (SELECT hero_media_urls
   FROM public.get_public_company_by_slug('legacy-video'))
    = ARRAY['https://cdn.test/legacy-video.mp4'],
  'public company RPC did not expose the gallery'
);

SELECT public.test_assert(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'companies_public'
      AND column_name = 'hero_media_urls'
  ),
  'public company view did not expose the gallery'
);

SELECT public.test_assert(
  EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'storage.objects'::regclass
      AND polname = 'Company admins can delete company hero media assets'
      AND polcmd = 'd'
      AND 'authenticated'::regrole::oid = ANY(polroles)
  ),
  'authenticated hero-media deletion policy is absent'
);

INSERT INTO storage.objects (bucket_id, name)
VALUES
  ('system-assets', 'company-hero-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/own.jpg'),
  ('system-assets', 'company-hero-media/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/other.jpg');

INSERT INTO public.user_roles (user_id, company_id, role)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'admin'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

SELECT public.test_assert(
  auth.uid() = '11111111-1111-4111-8111-111111111111'::uuid,
  'authenticated test context did not expose auth.uid()'
);

SELECT public.test_assert(
  EXISTS (
    SELECT 1
    FROM public.user_roles AS roles
    WHERE roles.user_id = auth.uid()
      AND roles.role = 'admin'::public.app_role
      AND roles.company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid
  ),
  'authenticated company admin role was not visible to the policy'
);

DELETE FROM storage.objects
WHERE name = 'company-hero-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/own.jpg';

DELETE FROM storage.objects
WHERE name = 'company-hero-media/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/other.jpg';

RESET ROLE;

SELECT public.test_assert(
  NOT EXISTS (
    SELECT 1 FROM storage.objects
    WHERE name = 'company-hero-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/own.jpg'
  ),
  'company admin could not delete an owned hero-media object'
);

SELECT public.test_assert(
  EXISTS (
    SELECT 1 FROM storage.objects
    WHERE name = 'company-hero-media/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/other.jpg'
  ),
  'company admin deleted another company hero-media object'
);

ROLLBACK;
