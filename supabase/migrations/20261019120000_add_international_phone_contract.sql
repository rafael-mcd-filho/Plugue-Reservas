-- Additive contract only: this migration does NOT backfill customer data or queues.
-- New callers send +E.164. National numbers without + retain the legacy BR contract.
CREATE OR REPLACE FUNCTION public.phone_to_e164(_phone text, _country text DEFAULT 'BR')
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  WITH input AS (
    SELECT btrim(COALESCE(_phone, '')) AS raw,
      regexp_replace(COALESCE(_phone, ''), '\D', '', 'g') AS digits
  )
  , candidate AS (SELECT CASE
    WHEN raw = '' OR raw !~ '^\+?[0-9() .-]+$' THEN NULL
    WHEN raw LIKE '+%' AND digits ~ '^[1-9][0-9]{6,14}$' THEN '+' || digits
    WHEN upper(COALESCE(_country, 'BR')) = 'BR' AND digits ~ '^[1-9][0-9]9?[0-9]{8}$'
      THEN '+55' || digits
    WHEN upper(COALESCE(_country, 'BR')) = 'BR' AND digits ~ '^55[1-9][0-9]9?[0-9]{8}$'
      THEN '+' || digits
    ELSE NULL
  END AS value FROM input)
  SELECT CASE WHEN public.is_valid_phone_e164(value) THEN value ELSE NULL END FROM candidate;
$$;

-- Historical BR mobile numbers with eight subscriber digits may still be
-- accepted by providers. Preserve their exact stored number, without inventing
-- a ninth digit, while keeping phone_to_e164 strict for new contact entry.
CREATE OR REPLACE FUNCTION public.phone_stored_identity_digits(_e164 text, _raw text, _country text DEFAULT 'BR')
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  WITH input AS (
    SELECT COALESCE(NULLIF(btrim(_e164), ''), btrim(COALESCE(_raw, ''))) AS raw,
      substring(COALESCE(public.phone_to_e164(_e164, 'ZZ'), public.phone_to_e164(_raw, _country)) FROM 2) AS canonical
  ), digits AS (
    SELECT *, regexp_replace(raw, '\D', '', 'g') AS value FROM input
  )
  SELECT COALESCE(canonical, CASE
    WHEN upper(COALESCE(_country, 'BR')) <> 'BR' OR raw !~ '^\+?[0-9() .-]+$' THEN NULL
    WHEN raw LIKE '+%' AND value ~ '^55[1-9][0-9](9?[0-9]{8})$' THEN value
    WHEN raw NOT LIKE '+%' AND value ~ '^[1-9][0-9](9?[0-9]{8})$' THEN '55' || value
    WHEN raw NOT LIKE '+%' AND value ~ '^55[1-9][0-9](9?[0-9]{8})$' THEN value
    ELSE NULL
  END) FROM digits;
$$;

CREATE OR REPLACE FUNCTION public.phone_identity_digits(_e164 text, _raw text, _country text DEFAULT 'BR')
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT public.phone_stored_identity_digits(_e164, _raw, _country);
$$;

CREATE OR REPLACE FUNCTION public.normalize_whatsapp_phone(_phone text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT substring(public.phone_to_e164(_phone, 'BR') FROM 2);
$$;

-- Customer identity is a read-model concern, independent from deliverability.
-- Preserve historical grouping for legacy BR values rejected by modern metadata;
-- never use this fallback to validate a new write, create a dispatch, or send.
CREATE OR REPLACE FUNCTION public.phone_customer_identity_digits(_e164 text, _raw text, _country text DEFAULT 'BR')
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  WITH input AS (
    SELECT regexp_replace(COALESCE(_raw, ''), '\D', '', 'g') AS digits,
      public.phone_identity_digits(_e164, _raw, _country) AS canonical
  )
  SELECT COALESCE(canonical, CASE
    WHEN upper(COALESCE(_country, 'BR')) <> 'BR' OR digits = '' THEN NULL
    WHEN digits !~ '^55' AND length(digits) <= 11 THEN '55' || digits
    ELSE digits
  END) FROM input;
$$;

COMMENT ON FUNCTION public.phone_customer_identity_digits(text, text, text) IS
  'Read models only: valid E.164 identity, otherwise the unchanged historical BR identity. Never validates or authorizes delivery to an invalid number.';

CREATE OR REPLACE FUNCTION public.canonical_phone_dispatch_key(_key text, _phone_digits text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN _phone_digits ~ '^[1-9][0-9]{6,14}$'
      AND _key ~ '^(pluguechat:(broadcast:[^:]+|birthday:[^:]+:[0-9]{4}-[0-9]{2}-[0-9]{2})|birthday:[^:]+:[0-9]{4}-[0-9]{2}-[0-9]{2}):[^:]+$'
    THEN regexp_replace(_key, ':[^:]+$', ':' || _phone_digits) ELSE _key END;
$$;

COMMENT ON FUNCTION public.phone_to_e164(text, text) IS
  'E.164 boundary validated with pinned libphonenumber max metadata. Bare national input is BR only. Never pass international digits without +.';

-- Fixed allowlist shared by schema setup and the separately invoked migration tooling.
CREATE OR REPLACE FUNCTION public._international_phone_targets()
RETURNS TABLE(table_name text, raw_column text)
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  VALUES ('reservations', 'guest_phone'), ('waitlist', 'guest_phone'),
    ('reservation_companions', 'phone'), ('waitlist_companions', 'phone'),
    ('crm_leads', 'phone'), ('profiles', 'phone'),
    ('companies', 'phone'), ('companies', 'responsible_phone'), ('companies', 'whatsapp'),
    ('whatsapp_message_queue', 'phone'), ('whatsapp_broadcast_recipients', 'phone'),
    ('pluguechat_message_queue', 'phone'), ('pluguechat_broadcast_recipients', 'phone'),
    ('lead_reactivation_dispatches', 'phone'), ('whatsapp_dispatch_guards', 'phone');
$$;

CREATE OR REPLACE FUNCTION public.sync_international_phone_columns()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  _raw_column text := TG_ARGV[0];
  _e164_column text := TG_ARGV[0] || '_e164';
  _country_column text := TG_ARGV[0] || '_country';
  _row jsonb := to_jsonb(NEW);
  _old jsonb;
  _raw text;
  _e164 text;
  _country text;
  _patch jsonb;
  _delivery_table boolean := TG_TABLE_NAME IN (
    'whatsapp_message_queue', 'whatsapp_broadcast_recipients',
    'pluguechat_message_queue', 'pluguechat_broadcast_recipients',
    'lead_reactivation_dispatches', 'whatsapp_dispatch_guards'
  );
BEGIN
  IF current_setting('app.phone_backfill', true) = 'on' THEN RETURN NEW; END IF;
  _raw := NULLIF(btrim(_row ->> _raw_column), '');
  _e164 := NULLIF(btrim(_row ->> _e164_column), '');
  _country := NULLIF(upper(btrim(_row ->> _country_column)), '');
  IF TG_TABLE_NAME = 'crm_leads' AND _raw IS NULL AND _e164 IS NULL THEN
    -- Historical CRM imports sometimes stored ONLY national BR phone_normalized.
    -- New international callers must provide raw +E.164 or phone_e164 explicitly.
    _e164 := public.phone_to_e164(NULLIF(_row ->> 'phone_normalized', ''), 'BR');
  END IF;

  IF TG_OP = 'UPDATE' THEN
    _old := to_jsonb(OLD);
    IF TG_TABLE_NAME = 'crm_leads' AND _raw IS NULL
      AND NULLIF(_row ->> 'phone_normalized', '') IS NULL
      AND NULLIF(_old ->> 'phone_normalized', '') IS NOT NULL
      AND _row ->> _e164_column IS NOT DISTINCT FROM _old ->> _e164_column THEN
      _e164 := NULL;
      _country := NULL;
    END IF;
    -- A legacy caller may change only raw; discard stale canonical metadata.
    IF _row ->> _raw_column IS DISTINCT FROM _old ->> _raw_column
      AND _row ->> _e164_column IS NOT DISTINCT FROM _old ->> _e164_column THEN
      _e164 := NULL;
      IF _row ->> _country_column IS NOT DISTINCT FROM _old ->> _country_column THEN _country := NULL; END IF;
    END IF;
  END IF;

  IF _raw IS NULL AND _e164 IS NULL THEN
    _country := NULL;
  ELSE
    IF _e164 IS NOT NULL AND NOT public.is_valid_phone_e164(_e164)
      AND NOT (_delivery_table AND _e164 LIKE '+%'
        AND public.phone_stored_identity_digits(_e164, NULL, COALESCE(_country, 'BR')) IS NOT NULL) THEN
      RAISE EXCEPTION 'Telefone internacional invalido. Use +DDI e numero.' USING ERRCODE = '22023';
    END IF;
    IF _raw LIKE '+%' AND _e164 IS NOT NULL
      AND (CASE WHEN _delivery_table
        THEN '+' || public.phone_stored_identity_digits(NULL, _raw, COALESCE(_country, 'BR'))
        ELSE public.phone_to_e164(_raw, 'ZZ') END) IS DISTINCT FROM _e164 THEN
      RAISE EXCEPTION 'Telefone e telefone internacional divergentes.' USING ERRCODE = '22023';
    END IF;
    _e164 := COALESCE(_e164, public.phone_to_e164(_raw, COALESCE(_country, 'BR')));
    IF _e164 IS NULL AND _delivery_table THEN
      _e164 := '+' || public.phone_stored_identity_digits(NULL, _raw, COALESCE(_country, 'BR'));
    END IF;
    IF _e164 IS NULL THEN
      RAISE EXCEPTION 'Telefone invalido. Informe o DDI para numeros internacionais.' USING ERRCODE = '22023';
    END IF;
    IF _country IS NOT NULL AND (public.phone_country_calling_code(_country) IS NULL
      OR _e164 NOT LIKE '+' || public.phone_country_calling_code(_country) || '%') THEN
      RAISE EXCEPTION 'Pais incompativel com o telefone internacional.' USING ERRCODE = '22023';
    END IF;
    -- Do not guess a country for shared calling codes (+1 etc.).
    _country := COALESCE(_country, public.phone_e164_default_country(_e164));
  END IF;
  _patch := jsonb_build_object(_e164_column, _e164, _country_column, _country);
  IF _row ? 'phone_normalized' AND TG_TABLE_NAME IN ('crm_leads', 'whatsapp_broadcast_recipients', 'lead_reactivation_dispatches') THEN
    _patch := _patch || jsonb_build_object('phone_normalized', substring(_e164 FROM 2));
  END IF;
  NEW := jsonb_populate_record(NEW, _patch);
  RETURN NEW;
END;
$$;

DO $migration$
DECLARE _target record; _e164 text; _country text; _constraint text;
BEGIN
  -- Keep the legacy generated column's historical values; new writes are maintained
  -- by the trigger. Its former last-11-digits index is replaced below.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'whatsapp_broadcast_recipients' AND column_name = 'phone_normalized'
      AND is_generated = 'ALWAYS') THEN
    ALTER TABLE public.whatsapp_broadcast_recipients ALTER COLUMN phone_normalized DROP EXPRESSION;
  END IF;

  FOR _target IN SELECT * FROM public._international_phone_targets() LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = _target.table_name AND column_name = _target.raw_column) THEN CONTINUE; END IF;
    _e164 := _target.raw_column || '_e164';
    _country := _target.raw_column || '_country';
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I text, ADD COLUMN IF NOT EXISTS %I text',
      _target.table_name, _e164, _country);
    _constraint := _target.table_name || '_' || _target.raw_column || '_intl_check';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('public.' || _target.table_name)::regclass AND conname = _constraint) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((%I IS NULL OR %I ~ %L) AND (%I IS NULL OR %I ~ %L)) NOT VALID',
        _target.table_name, _constraint, _e164, _e164, '^\+[1-9][0-9]{6,14}$', _country, _country, '^[A-Z]{2}$');
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'a_sync_' || _target.raw_column || '_international', _target.table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I, %I, %I ON public.%I FOR EACH ROW EXECUTE FUNCTION public.sync_international_phone_columns(%L)',
      'a_sync_' || _target.raw_column || '_international', _target.raw_column, _e164, _country, _target.table_name, _target.raw_column);
  END LOOP;
END;
$migration$;

-- Evaluate legacy raw through the same boundary until the reviewed backfill runs.
-- No rows are removed or merged when replacing these indexes.
DROP INDEX IF EXISTS public.idx_broadcast_recipients_broadcast_phone_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_phone_unique
  ON public.whatsapp_broadcast_recipients(broadcast_id, (public.phone_identity_digits(phone_e164, phone, phone_country)))
  WHERE public.phone_identity_digits(phone_e164, phone, phone_country) IS NOT NULL;

DROP INDEX IF EXISTS public.idx_whatsapp_queue_active_phone_message_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_queue_active_phone_message_unique
  ON public.whatsapp_message_queue(company_id, type,
    (public.phone_identity_digits(phone_e164, phone, phone_country)), (md5(message)))
  WHERE reservation_id IS NULL AND status IN ('pending', 'processing')
    AND public.phone_identity_digits(phone_e164, phone, phone_country) IS NOT NULL;

-- These may reveal legacy formatting duplicates. Fail atomically for review rather
-- than deleting recipients or silently allowing repeated deliveries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pluguechat_broadcast_phone_e164_unique
  ON public.pluguechat_broadcast_recipients(broadcast_id, (public.phone_identity_digits(phone_e164, phone, phone_country)))
  WHERE public.phone_identity_digits(phone_e164, phone, phone_country) IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_reactivation_canonical_phone_unique
  ON public.lead_reactivation_dispatches(company_id,
    (public.phone_identity_digits(phone_e164, phone, phone_country)), last_visit_date, days_without_visit)
  WHERE public.phone_identity_digits(phone_e164, phone, phone_country) IS NOT NULL;

-- Legacy CSV imports used national digits in phone_normalized; new writes use
-- full international digits. Enforce one identity across both representations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_leads_company_canonical_phone_unique
  ON public.crm_leads(company_id, (COALESCE(
    public.phone_identity_digits(phone_e164, phone, phone_country),
    public.phone_identity_digits(NULL, phone_normalized, 'BR')
  )))
  WHERE COALESCE(public.phone_identity_digits(phone_e164, phone, phone_country),
    public.phone_identity_digits(NULL, phone_normalized, 'BR')) IS NOT NULL;

-- Historical phone_normalized values remain untouched. A BR national value such
-- as 33912345678 can equal a valid French E.164 digits value (+33912345678).
-- The canonical indexes above replace the old raw-column uniqueness rules;
-- retaining both would incorrectly reject distinct customers in those countries.
DROP INDEX IF EXISTS public.crm_leads_company_phone_unique;

DO $migration$
DECLARE _constraint record;
BEGIN
  FOR _constraint IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'public.lead_reactivation_dispatches'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.position)
        FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ) = ARRAY['company_id', 'phone_normalized', 'last_visit_date', 'days_without_visit']::text[]
  LOOP
    EXECUTE format('ALTER TABLE public.lead_reactivation_dispatches DROP CONSTRAINT %I', _constraint.conname);
  END LOOP;
END;
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pluguechat_queue_canonical_dispatch_unique
  ON public.pluguechat_message_queue((public.canonical_phone_dispatch_key(idempotency_key,
    public.phone_identity_digits(phone_e164, phone, phone_country))))
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_guard_canonical_birthday_unique
  ON public.whatsapp_dispatch_guards((public.canonical_phone_dispatch_key(delivery_key,
    public.phone_identity_digits(phone_e164, phone, phone_country))))
  WHERE delivery_key LIKE 'birthday:%';

CREATE INDEX IF NOT EXISTS idx_reservations_company_phone_e164
  ON public.reservations(company_id, (public.phone_identity_digits(guest_phone_e164, guest_phone, guest_phone_country)));
CREATE INDEX IF NOT EXISTS idx_waitlist_company_phone_e164
  ON public.waitlist(company_id, (public.phone_identity_digits(guest_phone_e164, guest_phone, guest_phone_country)));

REVOKE ALL ON FUNCTION public._international_phone_targets() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_international_phone_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.phone_customer_identity_digits(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.phone_to_e164(text, text), public.phone_identity_digits(text, text, text),
  public.phone_stored_identity_digits(text, text, text), public.normalize_whatsapp_phone(text) TO anon, authenticated, service_role;
