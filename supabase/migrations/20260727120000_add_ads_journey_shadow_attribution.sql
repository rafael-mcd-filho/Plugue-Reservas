-- Ads journey attribution V2 (shadow mode).
--
-- This migration is deliberately additive:
--   - the current reservation-origin classifier remains untouched;
--   - company/customer dashboards continue to use V1;
--   - V2 is collected only for companies explicitly set to shadow;
--   - no historical reservation is backfilled or reclassified.

ALTER TABLE public.company_tracking_settings
  ADD COLUMN IF NOT EXISTS ads_attribution_mode text NOT NULL DEFAULT 'off';

ALTER TABLE public.company_tracking_settings
  DROP CONSTRAINT IF EXISTS company_tracking_settings_ads_attribution_mode_check;

ALTER TABLE public.company_tracking_settings
  ADD CONSTRAINT company_tracking_settings_ads_attribution_mode_check
  CHECK (ads_attribution_mode IN ('off', 'shadow'));

COMMENT ON COLUMN public.company_tracking_settings.ads_attribution_mode IS
  'Controls Ads journey V2 collection. off disables it; shadow records V2 without changing customer-visible V1 metrics.';

CREATE OR REPLACE FUNCTION public.guard_ads_attribution_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.ads_attribution_mode IS NOT DISTINCT FROM OLD.ads_attribution_mode
  THEN
    RETURN NEW;
  END IF;

  -- Company admins can continue creating their regular tracking settings,
  -- whose safe default is off. Only platform-level actors can enable V2.
  IF TG_OP = 'INSERT' AND NEW.ads_attribution_mode = 'off' THEN
    RETURN NEW;
  END IF;

  IF current_user IN ('postgres', 'service_role', 'supabase_admin')
    OR COALESCE(
      public.has_role(auth.uid(), 'superadmin'::public.app_role),
      false
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only superadmins can change Ads attribution mode'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_ads_attribution_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_ads_attribution_mode() FROM anon;
REVOKE ALL ON FUNCTION public.guard_ads_attribution_mode() FROM authenticated;

DROP TRIGGER IF EXISTS guard_ads_attribution_mode_on_insert
ON public.company_tracking_settings;

CREATE TRIGGER guard_ads_attribution_mode_on_insert
BEFORE INSERT ON public.company_tracking_settings
FOR EACH ROW
EXECUTE FUNCTION public.guard_ads_attribution_mode();

DROP TRIGGER IF EXISTS guard_ads_attribution_mode_on_update
ON public.company_tracking_settings;

CREATE TRIGGER guard_ads_attribution_mode_on_update
BEFORE UPDATE OF ads_attribution_mode ON public.company_tracking_settings
FOR EACH ROW
EXECUTE FUNCTION public.guard_ads_attribution_mode();

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS ads_journey_is_ads boolean,
  ADD COLUMN IF NOT EXISTS ads_journey_version smallint,
  ADD COLUMN IF NOT EXISTS ads_journey_evaluated_at timestamptz,
  ADD COLUMN IF NOT EXISTS ads_journey_first_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS ads_journey_last_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS ads_journey_snapshot jsonb;

ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS reservations_ads_journey_version_check;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_ads_journey_version_check
  CHECK (
    ads_journey_version IS NULL
    OR ads_journey_version = 2
  );

CREATE INDEX IF NOT EXISTS idx_reservations_ads_journey_comparison
ON public.reservations(company_id, date, ads_journey_is_ads)
WHERE ads_journey_version = 2;

CREATE INDEX IF NOT EXISTS idx_reservations_date_ads_journey_comparison
ON public.reservations(
  date,
  company_id,
  ads_journey_version,
  ads_journey_is_ads
);

COMMENT ON COLUMN public.reservations.ads_journey_is_ads IS
  'Frozen V2 Ads result at reservation creation. NULL means the reservation was not evaluated; false is a real evaluated result.';

COMMENT ON COLUMN public.reservations.ads_journey_snapshot IS
  'Immutable diagnostic snapshot for Ads journey V2. It does not replace attribution_snapshot or the legacy origin classifier.';

ALTER TABLE public.tracking_sessions
  ADD COLUMN IF NOT EXISTS pr_ad text;

COMMENT ON COLUMN public.tracking_sessions.pr_ad IS
  'First-party custom paid marker captured for Ads journey V2.';

CREATE TABLE IF NOT EXISTS public.ads_journey_states (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  anonymous_id text NOT NULL,
  chain_id uuid NOT NULL DEFAULT gen_random_uuid(),
  first_paid_touch_at timestamptz NOT NULL,
  last_paid_touch_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  paid_utm_source text,
  paid_utm_medium text,
  paid_utm_campaign text,
  paid_custom_marker text,
  paid_evidence text NOT NULL,
  last_activity_kind text,
  last_session_id uuid,
  last_journey_id uuid,
  last_reservation_id uuid,
  last_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, anonymous_id),
  CONSTRAINT ads_journey_states_anonymous_id_check
    CHECK (
      NULLIF(btrim(anonymous_id), '') IS NOT NULL
      AND char_length(anonymous_id) <= 200
    ),
  CONSTRAINT ads_journey_states_paid_touch_order_check
    CHECK (last_paid_touch_at >= first_paid_touch_at),
  CONSTRAINT ads_journey_states_expiry_order_check
    CHECK (expires_at >= last_activity_at)
);

CREATE INDEX IF NOT EXISTS idx_ads_journey_states_expiry
ON public.ads_journey_states(expires_at);

ALTER TABLE public.ads_journey_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmins can inspect Ads journey states"
ON public.ads_journey_states;

CREATE POLICY "Superadmins can inspect Ads journey states"
ON public.ads_journey_states
FOR SELECT
TO authenticated
USING (
  public.has_role(
    auth.uid(),
    'superadmin'::public.app_role
  )
);

COMMENT ON TABLE public.ads_journey_states IS
  'One compact rolling state per company/browser identity after a paid touch. Organic-only visitors do not create rows.';

CREATE OR REPLACE FUNCTION public.record_ads_journey_activity(
  _company_id uuid,
  _anonymous_id text,
  _activity_at timestamptz,
  _utm_source text,
  _utm_medium text,
  _utm_campaign text,
  _pr_ad text,
  _session_id uuid,
  _journey_id uuid,
  _reservation_id uuid,
  _event_name text,
  _event_id text
)
RETURNS TABLE (
  attribution_mode text,
  is_active boolean,
  first_paid_touch_at timestamptz,
  last_paid_touch_at timestamptz,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _mode text := 'off';
  _anonymous text := NULLIF(btrim(COALESCE(_anonymous_id, '')), '');
  _at timestamptz := COALESCE(_activity_at, now());
  _source text := NULLIF(left(btrim(COALESCE(_utm_source, '')), 512), '');
  _medium text := NULLIF(
    left(lower(btrim(COALESCE(_utm_medium, ''))), 128),
    ''
  );
  _campaign text := NULLIF(
    left(btrim(COALESCE(_utm_campaign, '')), 512),
    ''
  );
  _custom_marker text := NULLIF(
    left(btrim(COALESCE(_pr_ad, '')), 512),
    ''
  );
  _event_kind text := NULLIF(
    left(btrim(COALESCE(_event_name, '')), 128),
    ''
  );
  _normalized_event_id text := NULLIF(
    left(btrim(COALESCE(_event_id, '')), 512),
    ''
  );
  _is_paid boolean := false;
  _state public.ads_journey_states%ROWTYPE;
BEGIN
  IF _company_id IS NULL OR _anonymous IS NULL THEN
    RETURN;
  END IF;

  IF char_length(_anonymous) > 200 THEN
    RETURN;
  END IF;

  SELECT settings.ads_attribution_mode
  INTO _mode
  FROM public.company_tracking_settings settings
  WHERE settings.company_id = _company_id;

  _mode := COALESCE(_mode, 'off');

  IF _mode <> 'shadow' THEN
    RETURN QUERY
    SELECT
      _mode,
      false,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::timestamptz;
    RETURN;
  END IF;

  _is_paid := COALESCE(_medium = 'paid', false)
    OR _custom_marker IS NOT NULL;

  SELECT state.*
  INTO _state
  FROM public.ads_journey_states state
  WHERE state.company_id = _company_id
    AND state.anonymous_id = _anonymous
  FOR UPDATE;

  IF NOT FOUND THEN
    IF NOT _is_paid THEN
      RETURN QUERY
      SELECT
        _mode,
        false,
        NULL::timestamptz,
        NULL::timestamptz,
        NULL::timestamptz;
      RETURN;
    END IF;

    INSERT INTO public.ads_journey_states (
      company_id,
      anonymous_id,
      first_paid_touch_at,
      last_paid_touch_at,
      last_activity_at,
      expires_at,
      paid_utm_source,
      paid_utm_medium,
      paid_utm_campaign,
      paid_custom_marker,
      paid_evidence,
      last_activity_kind,
      last_session_id,
      last_journey_id,
      last_reservation_id,
      last_event_id
    )
    VALUES (
      _company_id,
      _anonymous,
      _at,
      _at,
      _at,
      _at + interval '15 days',
      _source,
      _medium,
      _campaign,
      _custom_marker,
      CASE
        WHEN _custom_marker IS NOT NULL THEN 'pr_ad'
        ELSE 'utm_medium_paid'
      END,
      _event_kind,
      _session_id,
      _journey_id,
      _reservation_id,
      _normalized_event_id
    )
    ON CONFLICT (company_id, anonymous_id) DO NOTHING;

    SELECT state.*
    INTO _state
    FROM public.ads_journey_states state
    WHERE state.company_id = _company_id
      AND state.anonymous_id = _anonymous
    FOR UPDATE;
  END IF;

  IF _is_paid AND _at > _state.expires_at THEN
    UPDATE public.ads_journey_states
    SET
      chain_id = gen_random_uuid(),
      first_paid_touch_at = _at,
      last_paid_touch_at = _at,
      last_activity_at = _at,
      expires_at = _at + interval '15 days',
      paid_utm_source = _source,
      paid_utm_medium = _medium,
      paid_utm_campaign = _campaign,
      paid_custom_marker = _custom_marker,
      paid_evidence = CASE
        WHEN _custom_marker IS NOT NULL THEN 'pr_ad'
        ELSE 'utm_medium_paid'
      END,
      last_activity_kind = _event_kind,
      last_session_id = _session_id,
      last_journey_id = _journey_id,
      last_reservation_id = _reservation_id,
      last_event_id = _normalized_event_id,
      updated_at = now()
    WHERE company_id = _company_id
      AND anonymous_id = _anonymous;
  ELSIF _is_paid THEN
    UPDATE public.ads_journey_states AS state
    SET
      first_paid_touch_at = LEAST(state.first_paid_touch_at, _at),
      last_paid_touch_at = GREATEST(state.last_paid_touch_at, _at),
      last_activity_at = GREATEST(state.last_activity_at, _at),
      expires_at = GREATEST(state.expires_at, _at + interval '15 days'),
      paid_utm_source = COALESCE(_source, state.paid_utm_source),
      paid_utm_medium = COALESCE(_medium, state.paid_utm_medium),
      paid_utm_campaign = COALESCE(_campaign, state.paid_utm_campaign),
      paid_custom_marker = COALESCE(
        _custom_marker,
        state.paid_custom_marker
      ),
      paid_evidence = CASE
        WHEN _custom_marker IS NOT NULL THEN 'pr_ad'
        WHEN _medium = 'paid' THEN 'utm_medium_paid'
        ELSE state.paid_evidence
      END,
      last_activity_kind = _event_kind,
      last_session_id = COALESCE(_session_id, state.last_session_id),
      last_journey_id = COALESCE(_journey_id, state.last_journey_id),
      last_reservation_id = COALESCE(
        _reservation_id,
        state.last_reservation_id
      ),
      last_event_id = COALESCE(
        _normalized_event_id,
        state.last_event_id
      ),
      updated_at = now()
    WHERE company_id = _company_id
      AND anonymous_id = _anonymous;
  ELSIF (
    _at >= _state.first_paid_touch_at
    AND _at <= _state.expires_at
  ) THEN
    UPDATE public.ads_journey_states AS state
    SET
      last_activity_at = GREATEST(state.last_activity_at, _at),
      expires_at = GREATEST(
        state.expires_at,
        _at + interval '15 days'
      ),
      last_activity_kind = _event_kind,
      last_session_id = COALESCE(_session_id, state.last_session_id),
      last_journey_id = COALESCE(_journey_id, state.last_journey_id),
      last_reservation_id = COALESCE(
        _reservation_id,
        state.last_reservation_id
      ),
      last_event_id = COALESCE(
        _normalized_event_id,
        state.last_event_id
      ),
      updated_at = now()
    WHERE company_id = _company_id
      AND anonymous_id = _anonymous;
  END IF;

  SELECT state.*
  INTO _state
  FROM public.ads_journey_states state
  WHERE state.company_id = _company_id
    AND state.anonymous_id = _anonymous;

  RETURN QUERY
  SELECT
    _mode,
    (
      _state.first_paid_touch_at <= _at
      AND _state.expires_at >= _at
    ),
    _state.first_paid_touch_at,
    _state.last_paid_touch_at,
    _state.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ads_journey_activity(
  uuid,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  text,
  text
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.record_ads_journey_activity(
  uuid,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  text,
  text
) FROM anon;

REVOKE ALL ON FUNCTION public.record_ads_journey_activity(
  uuid,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  text,
  text
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.record_ads_journey_activity(
  uuid,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  text,
  text
) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_ads_journey_shadow_to_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _mode text := 'off';
  _anonymous_id text;
  _session_anonymous_id text;
  _session_utm_source text;
  _session_utm_medium text;
  _session_utm_campaign text;
  _session_pr_ad text;
  _is_public boolean;
  _conversion_at timestamptz := COALESCE(NEW.created_at, now());
  _state public.ads_journey_states%ROWTYPE;
  _is_ads boolean := false;
  _reason text := 'no_active_paid_chain';
BEGIN
  -- The trigger is INSERT-only so the V2 result is immutable after conversion.
  -- Never trust V2 values supplied by a public reservation payload.
  NEW.ads_journey_is_ads := NULL;
  NEW.ads_journey_version := NULL;
  NEW.ads_journey_evaluated_at := NULL;
  NEW.ads_journey_first_paid_at := NULL;
  NEW.ads_journey_last_paid_at := NULL;
  NEW.ads_journey_snapshot := NULL;

  _is_public := NEW.origin_tracking_session_id IS NOT NULL
    OR NULLIF(
      btrim(COALESCE(NEW.origin_anonymous_id, '')),
      ''
    ) IS NOT NULL
    OR COALESCE(
      NULLIF(
        btrim(COALESCE(
          NEW.attribution_snapshot ->> 'tracking_source',
          ''
        )),
        ''
      ) = 'public_web',
      false
    );

  IF COALESCE(NEW.source, 'reservation') = 'waitlist'
    OR NOT COALESCE(_is_public, false) THEN
    RETURN NEW;
  END IF;

  SELECT settings.ads_attribution_mode
  INTO _mode
  FROM public.company_tracking_settings settings
  WHERE settings.company_id = NEW.company_id;

  _mode := COALESCE(_mode, 'off');
  IF _mode <> 'shadow' THEN
    RETURN NEW;
  END IF;

  NEW.ads_journey_version := 2;
  NEW.ads_journey_evaluated_at := now();

  IF NEW.origin_tracking_session_id IS NOT NULL THEN
    SELECT
      session.anonymous_id,
      session.utm_source,
      session.utm_medium,
      session.utm_campaign,
      session.pr_ad
    INTO
      _session_anonymous_id,
      _session_utm_source,
      _session_utm_medium,
      _session_utm_campaign,
      _session_pr_ad
    FROM public.tracking_sessions session
    WHERE session.id = NEW.origin_tracking_session_id
      AND session.company_id = NEW.company_id
      AND session.last_seen_at >= _conversion_at - interval '30 minutes'
      AND session.last_seen_at <= _conversion_at + interval '5 minutes';
  END IF;

  _anonymous_id := COALESCE(
    NULLIF(btrim(COALESCE(NEW.origin_anonymous_id, '')), ''),
    NULLIF(btrim(COALESCE(_session_anonymous_id, '')), ''),
    NULLIF(btrim(COALESCE(
      NEW.attribution_snapshot ->> 'anonymous_id',
      ''
    )), ''),
    NULLIF(btrim(COALESCE(NEW.visitor_id, '')), '')
  );

  IF _anonymous_id IS NULL OR char_length(_anonymous_id) > 200 THEN
    NEW.ads_journey_is_ads := NULL;
    NEW.ads_journey_snapshot := jsonb_build_object(
      'version', 2,
      'mode', _mode,
      'status', 'insufficient_identity',
      'evaluated_at', NEW.ads_journey_evaluated_at
    );
    RETURN NEW;
  END IF;

  IF _session_anonymous_id IS DISTINCT FROM _anonymous_id THEN
    _session_utm_source := NULL;
    _session_utm_medium := NULL;
    _session_utm_campaign := NULL;
    _session_pr_ad := NULL;
  END IF;

  -- Close the race between an in-flight public-tracking request and the
  -- reservation INSERT. The reservation's own marker is recorded before its
  -- attribution is frozen, and an organic conversion renews an active chain.
  PERFORM public.record_ads_journey_activity(
    NEW.company_id,
    _anonymous_id,
    _conversion_at,
    COALESCE(
      NEW.attribution_snapshot ->> 'utm_source',
      _session_utm_source
    ),
    COALESCE(
      NEW.attribution_snapshot ->> 'utm_medium',
      _session_utm_medium
    ),
    COALESCE(
      NEW.attribution_snapshot ->> 'utm_campaign',
      _session_utm_campaign
    ),
    COALESCE(
      NEW.attribution_snapshot ->> 'pr_ad',
      _session_pr_ad
    ),
    NEW.origin_tracking_session_id,
    NEW.origin_tracking_journey_id,
    NEW.id,
    'reservation_created',
    format('reservation:%s:ads-journey-v2', NEW.id::text)
  );

  SELECT state.*
  INTO _state
  FROM public.ads_journey_states state
  WHERE state.company_id = NEW.company_id
    AND state.anonymous_id = _anonymous_id
  FOR UPDATE;

  IF FOUND
    AND _state.first_paid_touch_at <= _conversion_at
    AND _state.expires_at >= _conversion_at THEN
    _is_ads := true;
    _reason := _state.paid_evidence;

    NEW.ads_journey_first_paid_at := _state.first_paid_touch_at;
    NEW.ads_journey_last_paid_at := _state.last_paid_touch_at;
  END IF;

  NEW.ads_journey_is_ads := _is_ads;
  NEW.ads_journey_snapshot := jsonb_strip_nulls(jsonb_build_object(
    'version', 2,
    'mode', _mode,
    'status', CASE WHEN _is_ads THEN 'ads' ELSE 'not_ads' END,
    'reason', _reason,
    'anonymous_id', _anonymous_id,
    'chain_id', CASE WHEN _is_ads THEN _state.chain_id ELSE NULL END,
    'paid_utm_source', CASE
      WHEN _is_ads THEN _state.paid_utm_source
      ELSE NULL
    END,
    'paid_utm_medium', CASE
      WHEN _is_ads THEN _state.paid_utm_medium
      ELSE NULL
    END,
    'paid_utm_campaign', CASE
      WHEN _is_ads THEN _state.paid_utm_campaign
      ELSE NULL
    END,
    'paid_custom_marker', CASE
      WHEN _is_ads THEN _state.paid_custom_marker
      ELSE NULL
    END,
    'first_paid_at', NEW.ads_journey_first_paid_at,
    'last_paid_at', NEW.ads_journey_last_paid_at,
    'evaluated_at', NEW.ads_journey_evaluated_at
  ));

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Shadow collection must never block the customer's reservation.
    RAISE WARNING 'Ads journey V2 freeze failed for reservation %: %',
      NEW.id,
      SQLERRM;
    NEW.ads_journey_is_ads := NULL;
    NEW.ads_journey_version := NULL;
    NEW.ads_journey_evaluated_at := NULL;
    NEW.ads_journey_first_paid_at := NULL;
    NEW.ads_journey_last_paid_at := NULL;
    NEW.ads_journey_snapshot := NULL;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_ads_journey_shadow_to_reservation()
FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_ads_journey_shadow_to_reservation()
FROM anon;
REVOKE ALL ON FUNCTION public.apply_ads_journey_shadow_to_reservation()
FROM authenticated;

DROP TRIGGER IF EXISTS apply_ads_journey_shadow_before_reservation_insert
ON public.reservations;

CREATE TRIGGER apply_ads_journey_shadow_before_reservation_insert
BEFORE INSERT ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.apply_ads_journey_shadow_to_reservation();

CREATE OR REPLACE FUNCTION public.preserve_ads_journey_shadow_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- V2 is a conversion-time snapshot. Reservation edits must not silently
  -- rewrite the historical attribution result.
  NEW.ads_journey_is_ads := OLD.ads_journey_is_ads;
  NEW.ads_journey_version := OLD.ads_journey_version;
  NEW.ads_journey_evaluated_at := OLD.ads_journey_evaluated_at;
  NEW.ads_journey_first_paid_at := OLD.ads_journey_first_paid_at;
  NEW.ads_journey_last_paid_at := OLD.ads_journey_last_paid_at;
  NEW.ads_journey_snapshot := OLD.ads_journey_snapshot;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.preserve_ads_journey_shadow_snapshot()
FROM PUBLIC;

DROP TRIGGER IF EXISTS preserve_ads_journey_shadow_snapshot_on_update
ON public.reservations;

CREATE TRIGGER preserve_ads_journey_shadow_snapshot_on_update
BEFORE UPDATE OF
  ads_journey_is_ads,
  ads_journey_version,
  ads_journey_evaluated_at,
  ads_journey_first_paid_at,
  ads_journey_last_paid_at,
  ads_journey_snapshot
ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.preserve_ads_journey_shadow_snapshot();

CREATE OR REPLACE FUNCTION public.cleanup_expired_ads_journey_states(
  _expired_for interval DEFAULT interval '30 days'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _deleted bigint;
BEGIN
  IF _expired_for IS NULL OR _expired_for < interval '1 day' THEN
    RAISE EXCEPTION 'expired_for must be at least 1 day';
  END IF;

  DELETE FROM public.ads_journey_states
  WHERE expires_at < now() - _expired_for;

  GET DIAGNOSTICS _deleted = ROW_COUNT;
  RETURN _deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_ads_journey_states(interval)
FROM PUBLIC;

REVOKE ALL ON FUNCTION public.cleanup_expired_ads_journey_states(interval)
FROM anon;

REVOKE ALL ON FUNCTION public.cleanup_expired_ads_journey_states(interval)
FROM authenticated;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_ads_journey_states(interval)
TO service_role;

COMMENT ON FUNCTION public.cleanup_expired_ads_journey_states(interval) IS
  'Deletes compact Ads states after the requested expired period. Converted reservations retain their frozen snapshot. Scheduling is intentionally a separate rollout step.';

CREATE OR REPLACE FUNCTION public.get_ads_attribution_shadow_comparison(
  _company_id uuid,
  _start_date date,
  _end_date date
)
RETURNS TABLE (
  reservation_date date,
  total_reservations bigint,
  eligible_reservations bigint,
  evaluated_reservations bigint,
  legacy_ads bigint,
  journey_ads bigint,
  both_ads bigint,
  legacy_only_ads bigint,
  journey_only_ads bigint,
  insufficient_data bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(
    auth.uid(),
    'superadmin'::public.app_role
  ) THEN
    RAISE EXCEPTION 'Only superadmins can access Ads attribution comparison'
      USING ERRCODE = '42501';
  END IF;

  IF _start_date IS NULL OR _end_date IS NULL OR _end_date < _start_date THEN
    RAISE EXCEPTION 'Invalid comparison date range';
  END IF;

  IF _end_date - _start_date > 366 THEN
    RAISE EXCEPTION 'Comparison date range cannot exceed 367 days';
  END IF;

  RETURN QUERY
  WITH
  days AS (
    SELECT (_start_date + offsets.day_offset)::date AS reservation_date
    FROM generate_series(
      0,
      _end_date - _start_date
    ) AS offsets(day_offset)
  ),
  raw AS (
    SELECT
      reservation.id,
      reservation.date,
      reservation.source,
      reservation.origin_tracking_session_id,
      reservation.origin_anonymous_id,
      reservation.origin_affiliate_link_id,
      reservation.origin_fbc,
      reservation.attribution_snapshot,
      reservation.ads_journey_is_ads,
      reservation.ads_journey_version,
      session.utm_medium AS session_utm_medium,
      session.fbclid AS session_fbclid,
      session.fbc AS session_fbc,
      (
        reservation.origin_tracking_session_id IS NOT NULL
        OR NULLIF(
          btrim(COALESCE(reservation.origin_anonymous_id, '')),
          ''
        ) IS NOT NULL
        OR NULLIF(
          btrim(COALESCE(
            reservation.attribution_snapshot ->> 'tracking_source',
            ''
          )),
          ''
        ) = 'public_web'
      ) AS is_public,
      COALESCE(
        NULLIF(lower(btrim(
          reservation.attribution_snapshot ->> 'utm_medium'
        )), ''),
        NULLIF(lower(btrim(session.utm_medium)), '')
      ) AS legacy_effective_medium,
      (
        NULLIF(btrim(COALESCE(
          reservation.attribution_snapshot ->> 'fbclid',
          ''
        )), '') IS NOT NULL
        OR NULLIF(btrim(COALESCE(
          reservation.attribution_snapshot ->> 'fbc',
          ''
        )), '') IS NOT NULL
        OR NULLIF(btrim(COALESCE(session.fbclid, '')), '') IS NOT NULL
        OR NULLIF(btrim(COALESCE(reservation.origin_fbc, '')), '') IS NOT NULL
        OR NULLIF(btrim(COALESCE(session.fbc, '')), '') IS NOT NULL
      ) AS legacy_has_meta_click
    FROM public.reservations reservation
    LEFT JOIN public.tracking_sessions session
      ON session.id = reservation.origin_tracking_session_id
     AND session.company_id = reservation.company_id
    WHERE reservation.date >= _start_date
      AND reservation.date <= _end_date
      AND (
        _company_id IS NULL
        OR reservation.company_id = _company_id
      )
  ),
  classified AS (
    SELECT
      raw.*,
      (
        COALESCE(raw.source, 'reservation') <> 'waitlist'
        AND raw.is_public
      ) AS is_eligible,
      CASE
        WHEN COALESCE(raw.source, 'reservation') = 'waitlist' THEN false
        WHEN NOT raw.is_public THEN false
        WHEN raw.origin_affiliate_link_id IS NOT NULL THEN false
        WHEN (
          raw.legacy_effective_medium = ANY (ARRAY[
            'ads',
            'cpc',
            'cpm',
            'cpv',
            'paid',
            'paid-social',
            'paid_social',
            'ppc',
            'social_paid'
          ]::text[])
          OR raw.legacy_effective_medium LIKE 'paid%'
          OR raw.legacy_has_meta_click
        ) THEN true
        ELSE false
      END AS legacy_is_ads
    FROM raw
  ),
  daily AS (
    SELECT
      classified.date AS reservation_date,
      count(*)::bigint AS total_reservations,
      count(*) FILTER (
        WHERE classified.is_eligible
      )::bigint AS eligible_reservations,
      count(*) FILTER (
        WHERE classified.is_eligible
          AND classified.ads_journey_version = 2
          AND classified.ads_journey_is_ads IS NOT NULL
      )::bigint AS evaluated_reservations,
      count(*) FILTER (
        WHERE classified.is_eligible
          AND classified.ads_journey_version = 2
          AND classified.ads_journey_is_ads IS NOT NULL
          AND classified.legacy_is_ads
      )::bigint AS legacy_ads,
      count(*) FILTER (
        WHERE classified.is_eligible
          AND classified.ads_journey_version = 2
          AND classified.ads_journey_is_ads IS TRUE
      )::bigint AS journey_ads,
      count(*) FILTER (
        WHERE classified.is_eligible
          AND classified.ads_journey_version = 2
          AND classified.ads_journey_is_ads IS TRUE
          AND classified.legacy_is_ads
      )::bigint AS both_ads,
      count(*) FILTER (
        WHERE classified.is_eligible
          AND classified.ads_journey_version = 2
          AND classified.ads_journey_is_ads IS FALSE
          AND classified.legacy_is_ads
      )::bigint AS legacy_only_ads,
      count(*) FILTER (
        WHERE classified.is_eligible
          AND classified.ads_journey_version = 2
          AND classified.ads_journey_is_ads IS TRUE
          AND NOT classified.legacy_is_ads
      )::bigint AS journey_only_ads,
      count(*) FILTER (
        WHERE classified.is_eligible
          AND (
            classified.ads_journey_version IS DISTINCT FROM 2
            OR classified.ads_journey_is_ads IS NULL
          )
      )::bigint AS insufficient_data
    FROM classified
    GROUP BY classified.date
  )
  SELECT
    days.reservation_date,
    COALESCE(daily.total_reservations, 0)::bigint,
    COALESCE(daily.eligible_reservations, 0)::bigint,
    COALESCE(daily.evaluated_reservations, 0)::bigint,
    COALESCE(daily.legacy_ads, 0)::bigint,
    COALESCE(daily.journey_ads, 0)::bigint,
    COALESCE(daily.both_ads, 0)::bigint,
    COALESCE(daily.legacy_only_ads, 0)::bigint,
    COALESCE(daily.journey_only_ads, 0)::bigint,
    COALESCE(daily.insufficient_data, 0)::bigint
  FROM days
  LEFT JOIN daily
    ON daily.reservation_date = days.reservation_date
  ORDER BY days.reservation_date;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ads_attribution_shadow_comparison(
  uuid,
  date,
  date
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_ads_attribution_shadow_comparison(
  uuid,
  date,
  date
) TO authenticated;

COMMENT ON FUNCTION public.get_ads_attribution_shadow_comparison(
  uuid,
  date,
  date
) IS
  'Superadmin-only daily comparison of V1 and V2 on the same evaluated reservation cohort.';
