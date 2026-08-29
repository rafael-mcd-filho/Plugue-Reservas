-- Hero media gallery for public company pages.
--
-- A company may have either one video or up to four ordered images. The legacy
-- hero_media_url column remains synchronized with the first item so older
-- readers and writers keep working during the rollout.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS hero_media_urls text[] DEFAULT '{}'::text[];

ALTER TABLE public.companies
  ALTER COLUMN hero_media_urls SET DEFAULT '{}'::text[];

COMMENT ON COLUMN public.companies.hero_media_urls IS
  'Ordered public hero media URLs: one video or one to four images.';

-- Normalize the legacy state and backfill the ordered gallery. The extra CTEs
-- also make a partially applied development database converge safely by
-- trimming, removing empty entries and enforcing the final maximum length.
WITH prepared AS (
  SELECT
    companies.id,
    CASE
      WHEN cardinality(COALESCE(companies.hero_media_urls, '{}'::text[])) > 0 THEN
        ARRAY(
          SELECT NULLIF(btrim(media.url), '')
          FROM unnest(companies.hero_media_urls) WITH ORDINALITY AS media(url, position)
          WHERE NULLIF(btrim(media.url), '') IS NOT NULL
          ORDER BY media.position
        )
      WHEN NULLIF(btrim(companies.hero_media_url), '') IS NOT NULL THEN
        ARRAY[NULLIF(btrim(companies.hero_media_url), '')]
      ELSE
        '{}'::text[]
    END AS urls,
    companies.hero_media_type
  FROM public.companies AS companies
), typed AS (
  SELECT
    prepared.id,
    prepared.urls,
    CASE
      WHEN cardinality(prepared.urls) = 0 THEN NULL
      WHEN prepared.hero_media_type IN ('image', 'video') THEN prepared.hero_media_type
      WHEN lower(prepared.urls[1]) ~ '\.(mp4|webm|mov)([?#].*)?$' THEN 'video'
      ELSE 'image'
    END AS media_type
  FROM prepared
), normalized AS (
  SELECT
    typed.id,
    CASE
      WHEN typed.media_type = 'video' THEN typed.urls[1:1]
      ELSE typed.urls[1:4]
    END AS urls,
    typed.media_type
  FROM typed
)
UPDATE public.companies AS companies
SET
  hero_media_urls = normalized.urls,
  hero_media_url = normalized.urls[1],
  hero_media_type = normalized.media_type
FROM normalized
WHERE normalized.id = companies.id;

ALTER TABLE public.companies
  ALTER COLUMN hero_media_urls SET NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_company_hero_media_gallery()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  _urls text[];
BEGIN
  -- If only the legacy URL changed, treat it as an old client replacing or
  -- clearing the media. When the array changed, the ordered array is canonical.
  IF TG_OP = 'UPDATE'
    AND NEW.hero_media_urls IS NOT DISTINCT FROM OLD.hero_media_urls
    AND NEW.hero_media_url IS DISTINCT FROM OLD.hero_media_url THEN
    IF NULLIF(btrim(NEW.hero_media_url), '') IS NULL THEN
      _urls := '{}'::text[];
    ELSE
      _urls := ARRAY[NULLIF(btrim(NEW.hero_media_url), '')];
    END IF;
  ELSE
    SELECT COALESCE(
      array_agg(NULLIF(btrim(media.url), '') ORDER BY media.position)
        FILTER (WHERE NULLIF(btrim(media.url), '') IS NOT NULL),
      '{}'::text[]
    )
    INTO _urls
    FROM unnest(COALESCE(NEW.hero_media_urls, '{}'::text[]))
      WITH ORDINALITY AS media(url, position);

    IF cardinality(_urls) = 0
      AND TG_OP = 'INSERT'
      AND NULLIF(btrim(NEW.hero_media_url), '') IS NOT NULL THEN
      _urls := ARRAY[NULLIF(btrim(NEW.hero_media_url), '')];
    END IF;
  END IF;

  NEW.hero_media_urls := _urls;
  NEW.hero_media_url := _urls[1];

  IF cardinality(_urls) = 0 THEN
    NEW.hero_media_type := NULL;
  ELSIF NEW.hero_media_type IS NULL THEN
    NEW.hero_media_type := CASE
      WHEN lower(_urls[1]) ~ '\.(mp4|webm|mov)([?#].*)?$' THEN 'video'
      ELSE 'image'
    END;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_company_hero_media_gallery() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_company_hero_media_gallery() FROM anon;
REVOKE ALL ON FUNCTION public.sync_company_hero_media_gallery() FROM authenticated;

DROP TRIGGER IF EXISTS sync_company_hero_media_gallery
ON public.companies;

CREATE TRIGGER sync_company_hero_media_gallery
BEFORE INSERT OR UPDATE OF hero_media_url, hero_media_urls, hero_media_type
ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.sync_company_hero_media_gallery();

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_hero_media_type_check;

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_hero_media_gallery_check;

ALTER TABLE public.companies
  ADD CONSTRAINT companies_hero_media_gallery_check
  CHECK (
    array_position(hero_media_urls, NULL) IS NULL
    AND array_position(hero_media_urls, '') IS NULL
    AND (
      (
        hero_media_urls = '{}'::text[]
        AND hero_media_type IS NULL
        AND hero_media_url IS NULL
      )
      OR (
        hero_media_type IS NOT DISTINCT FROM 'video'
        AND cardinality(hero_media_urls) = 1
        AND hero_media_url IS NOT DISTINCT FROM hero_media_urls[1]
      )
      OR (
        hero_media_type IS NOT DISTINCT FROM 'image'
        AND cardinality(hero_media_urls) BETWEEN 1 AND 4
        AND hero_media_url IS NOT DISTINCT FROM hero_media_urls[1]
      )
    )
  );

CREATE OR REPLACE VIEW public.companies_public
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  slug,
  logo_url,
  description,
  phone,
  address,
  google_maps_url,
  whatsapp,
  instagram,
  opening_hours,
  payment_methods,
  reservation_duration,
  max_guests_per_slot,
  status,
  show_public_whatsapp_button,
  public_waitlist_enabled,
  show_public_sticky_reserve_button,
  show_public_reservation_exit_prompt,
  public_reservation_exit_prompt_primary_text,
  public_reservation_exit_prompt_primary_text_size,
  public_reservation_exit_prompt_secondary_text,
  public_reservation_exit_prompt_secondary_text_size,
  large_party_whatsapp_threshold,
  reservation_late_tolerance_minutes,
  hero_media_url,
  hero_media_type,
  public_header_style,
  hero_media_urls
FROM public.companies
WHERE status = 'active';

GRANT SELECT ON public.companies_public TO anon;
GRANT SELECT ON public.companies_public TO authenticated;

DROP FUNCTION IF EXISTS public.get_public_company_by_slug(text);

CREATE OR REPLACE FUNCTION public.get_public_company_by_slug(_slug text)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  logo_url text,
  hero_media_url text,
  hero_media_type text,
  public_header_style text,
  description text,
  phone text,
  address text,
  google_maps_url text,
  whatsapp text,
  show_public_whatsapp_button boolean,
  show_public_sticky_reserve_button boolean,
  public_waitlist_enabled boolean,
  instagram text,
  opening_hours jsonb,
  payment_methods jsonb,
  reservation_duration integer,
  max_guests_per_slot integer,
  status text,
  custom_public_page_enabled boolean,
  show_public_reservation_exit_prompt boolean,
  public_reservation_exit_prompt_primary_text text,
  public_reservation_exit_prompt_primary_text_size text,
  public_reservation_exit_prompt_secondary_text text,
  public_reservation_exit_prompt_secondary_text_size text,
  large_party_whatsapp_threshold integer,
  reservation_late_tolerance_minutes integer,
  hero_media_urls text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    companies.id,
    companies.name,
    companies.slug,
    companies.logo_url,
    companies.hero_media_url,
    companies.hero_media_type,
    companies.public_header_style,
    companies.description,
    companies.phone,
    companies.address,
    companies.google_maps_url,
    companies.whatsapp,
    companies.show_public_whatsapp_button,
    companies.show_public_sticky_reserve_button,
    companies.public_waitlist_enabled,
    companies.instagram,
    companies.opening_hours,
    companies.payment_methods,
    companies.reservation_duration,
    companies.max_guests_per_slot,
    companies.status,
    public.company_feature_enabled(companies.id, 'custom_public_page') AS custom_public_page_enabled,
    companies.show_public_reservation_exit_prompt,
    companies.public_reservation_exit_prompt_primary_text,
    companies.public_reservation_exit_prompt_primary_text_size,
    companies.public_reservation_exit_prompt_secondary_text,
    companies.public_reservation_exit_prompt_secondary_text_size,
    companies.large_party_whatsapp_threshold,
    companies.reservation_late_tolerance_minutes,
    companies.hero_media_urls
  FROM public.companies AS companies
  WHERE companies.slug = _slug
    AND companies.status = 'active'
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO authenticated;

DROP POLICY IF EXISTS "Company admins can delete company hero media assets"
ON storage.objects;

CREATE POLICY "Company admins can delete company hero media assets"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'system-assets'
  AND (storage.foldername(name))[1] = 'company-hero-media'
  AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.user_roles AS roles
      WHERE roles.user_id = auth.uid()
        AND roles.role = 'admin'::public.app_role
        AND roles.company_id::text = (storage.foldername(name))[2]
    )
  )
);
