-- Normalize legacy DDD 55 keys as aliases, including manually edited CRM profiles.
-- Old phone:55xxxxxxxxx was a national number left unprefixed by the old normalizer.
CREATE OR REPLACE FUNCTION public.canonical_crm_customer_key(_key text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN btrim(_key) ~ '^phone:55[0-9]{8,9}$'
      AND public.phone_stored_identity_digits(NULL, substring(btrim(_key) FROM 7), 'BR') IS NOT NULL
    THEN 'phone:55' || substring(btrim(_key) FROM 7) ELSE btrim(_key) END;
$$;

CREATE OR REPLACE FUNCTION public.get_public_reservation_prefill(
  _company_id uuid, _visitor_id text, _guest_phone text
)
RETURNS TABLE(guest_name text, guest_email text, guest_birthdate date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH matches AS (
    SELECT NULLIF(btrim(r.guest_name), '') AS guest_name,
      NULLIF(btrim(r.guest_email), '') AS guest_email, r.guest_birthdate, r.created_at
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND public.phone_identity_digits(r.guest_phone_e164, r.guest_phone, r.guest_phone_country)
        = public.normalize_whatsapp_phone(_guest_phone)
  )
  SELECT
    (SELECT m.guest_name FROM matches m WHERE m.guest_name IS NOT NULL ORDER BY m.created_at DESC LIMIT 1),
    (SELECT m.guest_email FROM matches m WHERE m.guest_email IS NOT NULL ORDER BY m.created_at DESC LIMIT 1),
    (SELECT m.guest_birthdate FROM matches m WHERE m.guest_birthdate IS NOT NULL ORDER BY m.created_at DESC LIMIT 1)
  WHERE EXISTS (SELECT 1 FROM matches);
$$;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_prefill(uuid, text, text) TO anon, authenticated;

-- Apply narrowly scoped changes to the currently installed RPCs, retaining their
-- authorization, temporal report contract, privacy masking, and pagination.
-- Every replacement is idempotent and only named public functions are considered.
DO $migration$
DECLARE
  _function record;
  _definition text;
  _updated text;
  _alias text;
  _raw text;
  _identity_helper text;
BEGIN
  FOR _function IN
    SELECT p.oid, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY (ARRAY[
      '_get_crm_contact_records', '_get_crm_lead_profiles', 'get_crm_lead_profile', 'get_crm_lead_presence_history',
      'upsert_crm_lead_profile', 'get_lead_reactivation_candidates',
      '_get_customer_recurrence_report_without_min_filter', 'get_customer_recurrence_report',
      '_crm_phone_state_code', 'join_public_waitlist', 'ensure_reservation_review',
      'enforce_public_reservation_rate_limit', 'capture_reservation_tracking_events'
    ])
  LOOP
    _definition := pg_get_functiondef(_function.oid);
    _updated := _definition;
    -- Reporting must retain invalid legacy BR identities and their visit groups.
    -- Operational automations and every validation boundary remain strict.
    _identity_helper := CASE WHEN _function.proname IN (
      '_get_crm_contact_records', '_get_crm_lead_profiles',
      '_get_customer_recurrence_report_without_min_filter', 'get_customer_recurrence_report'
    ) THEN 'phone_customer_identity_digits' ELSE 'phone_identity_digits' END;

    FOREACH _alias IN ARRAY ARRAY['reservations', 'reservation_companions', 'waitlist', 'waitlist_companions', 'future_reservations', 'future_companions'] LOOP
      _raw := CASE WHEN _alias IN ('reservations', 'waitlist', 'future_reservations') THEN 'guest_phone' ELSE 'phone' END;
      _updated := replace(_updated,
        format('public.normalize_whatsapp_phone(%s.%s)', _alias, _raw),
        format('public.%s(%s.%s_e164, %s.%s, %s.%s_country)', _identity_helper, _alias, _raw, _alias, _raw, _alias, _raw));
      IF _identity_helper = 'phone_customer_identity_digits' THEN
        -- Replaying after the strict contract was already installed also repairs
        -- only the named reporting functions, leaving indexes and sends strict.
        _updated := replace(_updated,
          format('public.phone_identity_digits(%s.%s_e164, %s.%s, %s.%s_country)', _alias, _raw, _alias, _raw, _alias, _raw),
          format('public.phone_customer_identity_digits(%s.%s_e164, %s.%s, %s.%s_country)', _alias, _raw, _alias, _raw, _alias, _raw));
      END IF;
    END LOOP;

    IF _function.proname = '_get_crm_lead_profiles' THEN
      _updated := replace(_updated,
        E'COALESCE(\n        public.normalize_whatsapp_phone(crm_leads.phone_normalized),\n        public.normalize_whatsapp_phone(crm_leads.phone)\n      )',
        'COALESCE(public.phone_customer_identity_digits(crm_leads.phone_e164, crm_leads.phone, crm_leads.phone_country), public.phone_customer_identity_digits(NULL, crm_leads.phone_normalized, ''BR''))');
      _updated := replace(_updated,
        'COALESCE(public.phone_identity_digits(crm_leads.phone_e164, crm_leads.phone, crm_leads.phone_country), public.phone_identity_digits(NULL, crm_leads.phone_normalized, ''BR''))',
        'COALESCE(public.phone_customer_identity_digits(crm_leads.phone_e164, crm_leads.phone, crm_leads.phone_country), public.phone_customer_identity_digits(NULL, crm_leads.phone_normalized, ''BR''))');
      _updated := replace(_updated,
        'COALESCE(public.phone_customer_identity_digits(crm_leads.phone_e164, crm_leads.phone, crm_leads.phone_country), public.phone_customer_identity_digits(NULL, crm_leads.phone_normalized, ''BR''))',
        'COALESCE(public.phone_identity_digits(crm_leads.phone_e164, crm_leads.phone, crm_leads.phone_country), public.phone_customer_identity_digits(NULL, crm_leads.phone_normalized, ''BR''), public.phone_customer_identity_digits(NULL, crm_leads.phone, crm_leads.phone_country))');
      _updated := replace(_updated,
        'THEN btrim(normalized_imports.profile_customer_key)',
        'THEN public.canonical_crm_customer_key(normalized_imports.profile_customer_key)');
      _updated := replace(_updated, 'NULLIF(btrim(latest_imports.phone), '''')',
        'COALESCE(latest_imports.phone_e164, NULLIF(btrim(latest_imports.phone), ''''))');
    END IF;

    IF _function.proname IN ('get_crm_lead_profile', 'upsert_crm_lead_profile', 'get_crm_lead_presence_history') THEN
      _updated := replace(_updated,
        'btrim(COALESCE(_customer_key, ''''))',
        'public.canonical_crm_customer_key(COALESCE(_customer_key, ''''))');
    END IF;

    IF _function.proname = 'get_crm_lead_presence_history' THEN
      _updated := replace(_updated, 'public.normalize_whatsapp_phone(_identity_value)',
        'public.normalize_whatsapp_phone(''+'' || _identity_value)');
      _updated := replace(_updated,
        'OR public.normalize_whatsapp_phone(''+'' || _identity_value) IS DISTINCT FROM _identity_value THEN',
        $new$OR (
        public.normalize_whatsapp_phone('+' || _identity_value) IS DISTINCT FROM _identity_value
        AND NOT EXISTS (
          SELECT 1 FROM public._get_crm_contact_records(_company_id) AS legacy_contact
          WHERE legacy_contact.customer_key = _effective_customer_key
        )
      ) THEN$new$);
    END IF;

    IF _function.proname = 'upsert_crm_lead_profile' THEN
      _updated := replace(_updated,
        $old$IF _phone_normalized !~ '^55[1-9][0-9](9?[0-9]{8})$' THEN$old$,
        $new$IF _phone_normalized IS NULL OR _phone_normalized !~ '^[1-9][0-9]{6,14}$' THEN$new$);
    END IF;

    IF _function.proname = '_crm_phone_state_code' THEN
      -- This argument is already canonical international digits, never a national input.
      _updated := replace(_updated,
        'WHEN digits LIKE ''55%'' AND length(digits) >= 12 THEN',
        'WHEN digits LIKE ''55%'' AND length(digits) IN (12, 13) THEN');
      _updated := replace(_updated,
        'WHEN length(digits) >= 10 THEN substring(digits FROM 1 FOR 2)',
        'WHEN false THEN NULL::text');
    END IF;

    IF _function.proname = 'join_public_waitlist' THEN
      _updated := replace(_updated,
        $old$regexp_replace(COALESCE(_guest_phone, ''), '\D', '', 'g')$old$,
        $new$public.phone_to_e164(_guest_phone, 'BR')$new$);
      _updated := replace(_updated,
        $old$IF _normalized_phone !~ '^(55)?[1-9][0-9](?:9?[0-9]{8})$' THEN$old$,
        $new$IF _normalized_phone IS NULL THEN$new$);
      _updated := replace(_updated,
        'Informe um WhatsApp valido com DDD.', 'Informe um WhatsApp valido com DDI e numero.');
      _updated := replace(_updated, 'w.guest_phone = _normalized_phone',
        'public.phone_identity_digits(w.guest_phone_e164, w.guest_phone, w.guest_phone_country) = substring(_normalized_phone FROM 2)');
      -- Include attempts made through the previous BR contract during the window.
      _updated := replace(_updated, 'AND identifier = _normalized_phone',
        'AND public.phone_to_e164(identifier, ''BR'') = _normalized_phone');
    END IF;

    IF _function.proname = 'ensure_reservation_review' THEN
      _updated := replace(_updated,
        $old$phone_normalized = regexp_replace(COALESCE(NEW.guest_phone, ''), '\D', '', 'g')$old$,
        $new$COALESCE(public.phone_identity_digits(phone_e164, phone, phone_country), public.phone_identity_digits(NULL, phone_normalized, 'BR')) = public.phone_identity_digits(NEW.guest_phone_e164, NEW.guest_phone, NEW.guest_phone_country)$new$);
    END IF;

    IF _function.proname = 'enforce_public_reservation_rate_limit' THEN
      _updated := replace(_updated, 'r.guest_phone = NEW.guest_phone',
        'public.phone_identity_digits(r.guest_phone_e164, r.guest_phone, r.guest_phone_country) = public.phone_identity_digits(NEW.guest_phone_e164, NEW.guest_phone, NEW.guest_phone_country)');
    END IF;

    IF _function.proname = 'capture_reservation_tracking_events' THEN
      -- Keep the country context in snapshots. An international +1 number has
      -- eleven digits, so stripping '+' would turn it into ambiguous BR input.
      _updated := replace(_updated,
        $old$NULLIF(regexp_replace(COALESCE(NEW.guest_phone, ''), '\D', '', 'g'), '')$old$,
        $new$COALESCE(NEW.guest_phone_e164, public.phone_to_e164(NEW.guest_phone, 'BR'))$new$);
    END IF;

    IF _updated IS DISTINCT FROM _definition THEN EXECUTE _updated; END IF;
  END LOOP;
END;
$migration$;

-- Stable read-model references still point to the original operational rows. No
-- reservation, waitlist, manual profile, dispatch key, or delivery status is rewritten.
COMMENT ON FUNCTION public.canonical_crm_customer_key(text) IS
  'Accepts historical BR DDD55 customer keys as aliases of their corrected E.164 identity, preserving manual profiles and old callers.';

CREATE OR REPLACE FUNCTION public.claim_whatsapp_dispatch(
  _delivery_key text, _company_id uuid, _automation_type text,
  _reservation_id uuid DEFAULT NULL, _phone text DEFAULT NULL, _lock_seconds integer DEFAULT 900
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _row_count integer := 0; _effective_key text := _delivery_key; _canonical_key text;
BEGIN
  IF NULLIF(btrim(COALESCE(_delivery_key, '')), '') IS NULL THEN RAISE EXCEPTION 'delivery_key is required'; END IF;
  IF _delivery_key LIKE 'birthday:%' THEN
    _canonical_key := public.canonical_phone_dispatch_key(_delivery_key, public.phone_stored_identity_digits(NULL, _phone, 'BR'));
    PERFORM pg_advisory_xact_lock(hashtext(_canonical_key));
    SELECT g.delivery_key INTO _effective_key FROM public.whatsapp_dispatch_guards g
    WHERE g.company_id = _company_id AND g.automation_type = _automation_type
      AND public.canonical_phone_dispatch_key(g.delivery_key, public.phone_identity_digits(g.phone_e164, g.phone, g.phone_country)) = _canonical_key
    ORDER BY (g.delivery_key = _delivery_key) DESC, g.created_at ASC LIMIT 1 FOR UPDATE;
    _effective_key := COALESCE(_effective_key, _delivery_key);
  END IF;
  INSERT INTO public.whatsapp_dispatch_guards (
    delivery_key, company_id, automation_type, reservation_id, phone, status, locked_until, finalized_at, last_error, updated_at
  ) VALUES (
    _effective_key, _company_id, _automation_type, _reservation_id, NULLIF(btrim(COALESCE(_phone, '')), ''),
    'processing', now() + make_interval(secs => GREATEST(COALESCE(_lock_seconds, 900), 60)), NULL, NULL, now()
  ) ON CONFLICT (delivery_key) DO UPDATE SET
    company_id = EXCLUDED.company_id, automation_type = EXCLUDED.automation_type,
    reservation_id = COALESCE(EXCLUDED.reservation_id, public.whatsapp_dispatch_guards.reservation_id),
    phone = COALESCE(EXCLUDED.phone, public.whatsapp_dispatch_guards.phone), status = 'processing',
    locked_until = now() + make_interval(secs => GREATEST(COALESCE(_lock_seconds, 900), 60)),
    finalized_at = NULL, last_error = NULL, updated_at = now()
  WHERE public.whatsapp_dispatch_guards.status = 'failed'
    OR (public.whatsapp_dispatch_guards.status = 'processing' AND public.whatsapp_dispatch_guards.locked_until <= now());
  GET DIAGNOSTICS _row_count = ROW_COUNT;
  RETURN _row_count > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_whatsapp_dispatch(_delivery_key text, _status text, _error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _canonical_key text;
BEGIN
  IF _status NOT IN ('accepted', 'queued', 'failed') THEN RAISE EXCEPTION 'invalid whatsapp dispatch status: %', _status; END IF;
  _canonical_key := public.canonical_phone_dispatch_key(_delivery_key,
    public.phone_stored_identity_digits(NULL, '+' || regexp_replace(_delivery_key, '^.*:', ''), 'BR'));
  UPDATE public.whatsapp_dispatch_guards g SET status = _status, locked_until = now(),
    finalized_at = now(), last_error = _error, updated_at = now()
  WHERE g.delivery_key = _delivery_key OR (
    _delivery_key LIKE 'birthday:%' AND g.delivery_key LIKE 'birthday:%'
    AND public.canonical_phone_dispatch_key(g.delivery_key, public.phone_identity_digits(g.phone_e164, g.phone, g.phone_country)) = _canonical_key
  );
END;
$$;
REVOKE ALL ON FUNCTION public.claim_whatsapp_dispatch(text, uuid, text, uuid, text, integer),
  public.finalize_whatsapp_dispatch(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_dispatch(text, uuid, text, uuid, text, integer),
  public.finalize_whatsapp_dispatch(text, text, text) TO service_role;
