-- Extend the rolling Ads journey V2 attribution window from 15 to 30 days.
-- V1 remains customer-visible; this changes only the shadow classifier.

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
  _window constant interval := interval '30 days';
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
      _at + _window,
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
      expires_at = _at + _window,
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
      expires_at = GREATEST(state.expires_at, _at + _window),
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
        _at + _window
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

-- Existing anonymous states adopt the new window immediately. Frozen
-- reservation snapshots remain unchanged.
UPDATE public.ads_journey_states
SET
  expires_at = GREATEST(
    expires_at,
    last_activity_at + interval '30 days'
  ),
  updated_at = now()
WHERE expires_at < last_activity_at + interval '30 days';

COMMENT ON FUNCTION public.record_ads_journey_activity(
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
) IS
  'Records Ads journey V2 activity using an exact paid marker and a rolling 30-day attribution window.';
