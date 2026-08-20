-- Hardening for the asynchronous funnel projection.
--
-- This migration remains completely downstream from tracking_events.  It does
-- not add a trigger to the capture table and does not replace or call any Meta
-- queue function.  The minute path reads a bounded raw-event window only;
-- projected-timestamp scans are reserved for the daily deletion reconciler.

CREATE OR REPLACE FUNCTION public._rebuild_tracking_funnel_sessions(
  _company_id uuid,
  _session_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _upserted integer := 0;
  _deleted integer := 0;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id é obrigatório.' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(cardinality(_session_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  -- A projected row must disappear when all raw events, or its only page_view,
  -- disappear.  The daily reconciler supplies projected session ids as well as
  -- raw ids, so this works even when no raw row remains in the repair window.
  DELETE FROM public.tracking_funnel_sessions projected
  WHERE projected.company_id = _company_id
    AND projected.session_id = ANY(_session_ids)
    AND NOT EXISTS (
      SELECT 1
      FROM public.tracking_events page_event
      WHERE page_event.company_id = _company_id
        AND page_event.session_id = projected.session_id
        AND page_event.tracking_source = 'public'
        AND page_event.event_name = 'page_view'
    );
  GET DIAGNOSTICS _deleted = ROW_COUNT;

  WITH requested_sessions AS MATERIALIZED (
    SELECT DISTINCT requested.session_id
    FROM unnest(_session_ids) AS requested(session_id)
    WHERE requested.session_id IS NOT NULL
  ),
  first_pages AS MATERIALIZED (
    SELECT DISTINCT ON (events.session_id)
      events.session_id,
      public._tracking_funnel_effective_at(
        events.occurred_at,
        events.created_at
      ) AS first_page_view_at,
      events.anonymous_id
    FROM requested_sessions
    JOIN public.tracking_events events
      ON events.company_id = _company_id
     AND events.session_id = requested_sessions.session_id
     AND events.tracking_source = 'public'
     AND events.event_name = 'page_view'
    ORDER BY
      events.session_id,
      public._tracking_funnel_effective_at(events.occurred_at, events.created_at),
      events.created_at,
      events.id
  ),
  rebuilt AS (
    SELECT
      _company_id AS company_id,
      first_pages.session_id,
      -- Identity is anchored on the first page, never on a pre-page event.
      first_pages.anonymous_id,
      first_pages.first_page_view_at AS first_event_created_at,
      first_pages.first_page_view_at,
      min(public._tracking_funnel_effective_at(
        events.occurred_at,
        events.created_at
      )) FILTER (
        WHERE events.event_name = 'date_select'
      ) AS date_selected_at,
      min(public._tracking_funnel_effective_at(
        events.occurred_at,
        events.created_at
      )) FILTER (
        WHERE events.event_name = 'time_select'
      ) AS time_selected_at,
      min(public._tracking_funnel_effective_at(
        events.occurred_at,
        events.created_at
      )) FILTER (
        WHERE events.event_name IN ('form_fill', 'lead_captured')
      ) AS form_filled_at,
      min(public._tracking_funnel_effective_at(
        events.occurred_at,
        events.created_at
      )) FILTER (
        WHERE events.event_name = 'reservation_created'
      ) AS completed_at,
      max(public._tracking_funnel_stage_number(events.event_name))::smallint AS max_stage,
      (array_agg(
        events.reservation_id
        ORDER BY
          public._tracking_funnel_effective_at(events.occurred_at, events.created_at) DESC,
          events.created_at DESC,
          events.id DESC
      ) FILTER (WHERE events.reservation_id IS NOT NULL))[1] AS reservation_id,
      max(public._tracking_funnel_effective_at(
        events.occurred_at,
        events.created_at
      )) AS last_event_created_at
    FROM first_pages
    JOIN public.tracking_events events
      ON events.company_id = _company_id
     AND events.session_id = first_pages.session_id
     AND events.tracking_source = 'public'
     AND events.event_name IN (
       'page_view', 'date_select', 'time_select',
       'form_fill', 'lead_captured', 'reservation_created'
     )
     -- This predicate is also present in the fast/raw implementation.
     AND public._tracking_funnel_effective_at(
       events.occurred_at,
       events.created_at
     ) >= first_pages.first_page_view_at
    GROUP BY
      first_pages.session_id,
      first_pages.anonymous_id,
      first_pages.first_page_view_at
  )
  INSERT INTO public.tracking_funnel_sessions AS target (
    company_id,
    session_id,
    anonymous_id,
    first_event_created_at,
    first_page_view_at,
    date_selected_at,
    time_selected_at,
    form_filled_at,
    completed_at,
    max_stage,
    reservation_id,
    last_event_created_at,
    projection_version,
    updated_at
  )
  SELECT
    rebuilt.company_id,
    rebuilt.session_id,
    rebuilt.anonymous_id,
    rebuilt.first_event_created_at,
    rebuilt.first_page_view_at,
    rebuilt.date_selected_at,
    rebuilt.time_selected_at,
    rebuilt.form_filled_at,
    rebuilt.completed_at,
    rebuilt.max_stage,
    rebuilt.reservation_id,
    rebuilt.last_event_created_at,
    1,
    clock_timestamp()
  FROM rebuilt
  ON CONFLICT (company_id, session_id) DO UPDATE
  SET
    anonymous_id = EXCLUDED.anonymous_id,
    first_event_created_at = EXCLUDED.first_event_created_at,
    first_page_view_at = EXCLUDED.first_page_view_at,
    date_selected_at = EXCLUDED.date_selected_at,
    time_selected_at = EXCLUDED.time_selected_at,
    form_filled_at = EXCLUDED.form_filled_at,
    completed_at = EXCLUDED.completed_at,
    max_stage = EXCLUDED.max_stage,
    reservation_id = EXCLUDED.reservation_id,
    last_event_created_at = EXCLUDED.last_event_created_at,
    projection_version = EXCLUDED.projection_version,
    updated_at = EXCLUDED.updated_at;
  GET DIAGNOSTICS _upserted = ROW_COUNT;

  RETURN _upserted + _deleted;
END;
$$;

-- Explicit repair window for operations/tests.  The minute projector does not
-- call it because the projected-timestamp OR predicates are intentionally kept
-- off the hot path.
CREATE OR REPLACE FUNCTION public._reconcile_tracking_funnel_company(
  _company_id uuid,
  _window_start timestamptz,
  _window_end timestamptz,
  _max_sessions integer DEFAULT 10000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _session_ids uuid[];
BEGIN
  IF _company_id IS NULL
    OR _window_start IS NULL
    OR _window_end IS NULL
    OR _window_end <= _window_start THEN
    RAISE EXCEPTION 'Parâmetros de reconciliação inválidos.' USING ERRCODE = '22023';
  END IF;

  IF _max_sessions IS NULL OR _max_sessions < 1 OR _max_sessions > 50000 THEN
    RAISE EXCEPTION 'max_sessions deve estar entre 1 e 50000.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-company:' || _company_id::text, 0)
  ) THEN
    RETURN 0;
  END IF;

  SELECT array_agg(candidates.session_id ORDER BY candidates.session_id)
  INTO _session_ids
  FROM (
    SELECT sessions.session_id
    FROM (
      SELECT events.session_id
      FROM public.tracking_events events
      WHERE events.company_id = _company_id
        AND events.tracking_source = 'public'
        AND events.session_id IS NOT NULL
        AND events.event_name IN (
          'page_view', 'date_select', 'time_select',
          'form_fill', 'lead_captured', 'reservation_created'
        )
        AND events.created_at >= _window_start
        AND events.created_at < _window_end

      UNION

      SELECT projected.session_id
      FROM public.tracking_funnel_sessions projected
      WHERE projected.company_id = _company_id
        AND (
          projected.first_page_view_at >= _window_start
            AND projected.first_page_view_at < _window_end
          OR projected.date_selected_at >= _window_start
            AND projected.date_selected_at < _window_end
          OR projected.time_selected_at >= _window_start
            AND projected.time_selected_at < _window_end
          OR projected.form_filled_at >= _window_start
            AND projected.form_filled_at < _window_end
          OR projected.completed_at >= _window_start
            AND projected.completed_at < _window_end
          OR projected.last_event_created_at >= _window_start
            AND projected.last_event_created_at < _window_end
        )
    ) sessions
    GROUP BY sessions.session_id
    ORDER BY sessions.session_id
    LIMIT _max_sessions
  ) candidates;

  RETURN public._rebuild_tracking_funnel_sessions(_company_id, _session_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public._reconcile_tracking_funnel_company_batch(
  _company_id uuid,
  _lookback interval DEFAULT interval '7 days',
  _max_sessions integer DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _now timestamptz := clock_timestamp();
  _window_start timestamptz;
  _window_end timestamptz;
  _cursor uuid;
  _candidate_ids uuid[];
  _selected_ids uuid[];
  _last_selected uuid;
  _has_more boolean := false;
  _reconciled integer := 0;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id é obrigatório.' USING ERRCODE = '22023';
  END IF;

  IF _lookback IS NULL OR _lookback < interval '1 hour' OR _lookback > interval '366 days' THEN
    RAISE EXCEPTION 'lookback deve estar entre 1 hora e 366 dias.' USING ERRCODE = '22023';
  END IF;

  IF _max_sessions IS NULL OR _max_sessions < 1 OR _max_sessions > 50000 THEN
    RAISE EXCEPTION 'max_sessions deve estar entre 1 e 50000.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-company:' || _company_id::text, 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked', 'company_id', _company_id);
  END IF;

  -- This write is outside the inner exception subtransaction.  A later error
  -- rolls back tenant work but cannot roll back its persisted diagnostics.
  INSERT INTO public.tracking_funnel_projection_state(
    company_id,
    last_reconciliation_started_at,
    updated_at
  )
  VALUES (_company_id, _now, _now)
  ON CONFLICT (company_id) DO UPDATE
  SET
    last_reconciliation_started_at = EXCLUDED.last_reconciliation_started_at,
    updated_at = EXCLUDED.updated_at;

  BEGIN
    SELECT
      state.reconciliation_window_start_at,
      state.reconciliation_window_end_at,
      state.reconciliation_cursor_session_id
    INTO _window_start, _window_end, _cursor
    FROM public.tracking_funnel_projection_state state
    WHERE state.company_id = _company_id
    FOR UPDATE;

    IF _window_start IS NULL OR _window_end IS NULL THEN
      _window_start := _now - _lookback;
      _window_end := _now + interval '1 microsecond';
      _cursor := NULL;

      UPDATE public.tracking_funnel_projection_state
      SET
        reconciliation_window_start_at = _window_start,
        reconciliation_window_end_at = _window_end,
        reconciliation_cursor_session_id = NULL,
        updated_at = _now
      WHERE company_id = _company_id;
    END IF;

    SELECT array_agg(candidates.session_id ORDER BY candidates.session_id)
    INTO _candidate_ids
    FROM (
      SELECT sessions.session_id
      FROM (
        SELECT events.session_id
        FROM public.tracking_events events
        WHERE events.company_id = _company_id
          AND events.tracking_source = 'public'
          AND events.session_id IS NOT NULL
          AND events.event_name IN (
            'page_view', 'date_select', 'time_select',
            'form_fill', 'lead_captured', 'reservation_created'
          )
          AND events.created_at >= _window_start
          AND events.created_at < _window_end

        UNION

        SELECT projected.session_id
        FROM public.tracking_funnel_sessions projected
        WHERE projected.company_id = _company_id
          AND (
            projected.first_page_view_at >= _window_start
              AND projected.first_page_view_at < _window_end
            OR projected.date_selected_at >= _window_start
              AND projected.date_selected_at < _window_end
            OR projected.time_selected_at >= _window_start
              AND projected.time_selected_at < _window_end
            OR projected.form_filled_at >= _window_start
              AND projected.form_filled_at < _window_end
            OR projected.completed_at >= _window_start
              AND projected.completed_at < _window_end
            OR projected.last_event_created_at >= _window_start
              AND projected.last_event_created_at < _window_end
          )
      ) sessions
      WHERE _cursor IS NULL OR sessions.session_id > _cursor
      GROUP BY sessions.session_id
      ORDER BY sessions.session_id
      LIMIT _max_sessions + 1
    ) candidates;

    _has_more := COALESCE(cardinality(_candidate_ids), 0) > _max_sessions;
    IF _has_more THEN
      _selected_ids := _candidate_ids[1:_max_sessions];
    ELSE
      _selected_ids := _candidate_ids;
    END IF;

    _reconciled := public._rebuild_tracking_funnel_sessions(
      _company_id,
      _selected_ids
    );

    IF COALESCE(cardinality(_selected_ids), 0) > 0 THEN
      _last_selected := _selected_ids[cardinality(_selected_ids)];
    END IF;

    UPDATE public.tracking_funnel_projection_state
    SET
      reconciliation_cursor_session_id = CASE
        WHEN _has_more THEN _last_selected
        ELSE NULL
      END,
      reconciliation_window_start_at = CASE
        WHEN _has_more THEN _window_start
        ELSE NULL
      END,
      reconciliation_window_end_at = CASE
        WHEN _has_more THEN _window_end
        ELSE NULL
      END,
      last_reconciled_at = CASE WHEN _has_more THEN last_reconciled_at ELSE _now END,
      next_reconciliation_attempt_at = '-infinity'::timestamptz,
      reconciliation_errors = 0,
      last_reconciliation_error = NULL,
      updated_at = _now
    WHERE company_id = _company_id;

    RETURN jsonb_build_object(
      'status', CASE WHEN _has_more THEN 'partial' ELSE 'ready' END,
      'company_id', _company_id,
      'sessions_reconciled', _reconciled,
      'has_more', _has_more,
      'cursor_session_id', CASE WHEN _has_more THEN _last_selected ELSE NULL END
    );
  EXCEPTION
    WHEN OTHERS THEN
      UPDATE public.tracking_funnel_projection_state
      SET
        reconciliation_errors = reconciliation_errors + 1,
        last_reconciliation_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
        next_reconciliation_attempt_at = clock_timestamp()
          + make_interval(secs => LEAST(
              3600,
              30 * (1 << LEAST(reconciliation_errors, 7))
            )),
        updated_at = clock_timestamp()
      WHERE company_id = _company_id;

      RETURN jsonb_build_object(
        'status', 'error',
        'company_id', _company_id,
        'sqlstate', SQLSTATE,
        'error', left(SQLERRM, 500)
      );
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public._project_tracking_funnel_company_batch(
  _company_id uuid,
  _batch_size integer DEFAULT 2000,
  _overlap interval DEFAULT interval '30 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _cursor_at timestamptz;
  _cursor_id uuid;
  _batch_first_at timestamptz;
  _batch_first_id uuid;
  _batch_last_at timestamptz;
  _batch_last_id uuid;
  _batch_count integer := 0;
  _affected_start timestamptz;
  _affected_end timestamptz;
  _affected_sessions uuid[];
  _projected_count integer := 0;
  _has_more boolean := false;
  _now timestamptz := clock_timestamp();
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id é obrigatório.' USING ERRCODE = '22023';
  END IF;

  IF _batch_size IS NULL OR _batch_size < 1 OR _batch_size > 10000 THEN
    RAISE EXCEPTION 'batch_size deve estar entre 1 e 10000.' USING ERRCODE = '22023';
  END IF;

  IF _overlap IS NULL OR _overlap < interval '1 minute' OR _overlap > interval '24 hours' THEN
    RAISE EXCEPTION 'overlap deve estar entre 1 minuto e 24 horas.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-company:' || _company_id::text, 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked', 'company_id', _company_id);
  END IF;

  -- Keep the state row outside the inner exception block so an error is
  -- observable after tenant work is rolled back.
  INSERT INTO public.tracking_funnel_projection_state(
    company_id,
    last_started_at,
    updated_at
  )
  VALUES (_company_id, _now, _now)
  ON CONFLICT (company_id) DO UPDATE
  SET
    last_started_at = EXCLUDED.last_started_at,
    updated_at = EXCLUDED.updated_at;

  BEGIN
    SELECT state.cursor_created_at, state.cursor_event_id
    INTO _cursor_at, _cursor_id
    FROM public.tracking_funnel_projection_state state
    WHERE state.company_id = _company_id
    FOR UPDATE;

    WITH batch_events AS MATERIALIZED (
      SELECT events.created_at, events.id
      FROM public.tracking_events events
      WHERE events.company_id = _company_id
        AND events.tracking_source = 'public'
        AND events.event_name IN (
          'page_view', 'date_select', 'time_select',
          'form_fill', 'lead_captured', 'reservation_created'
        )
        AND (
          _cursor_at IS NULL
          OR events.created_at > _cursor_at
          OR (events.created_at = _cursor_at AND events.id > _cursor_id)
        )
      ORDER BY events.created_at, events.id
      LIMIT _batch_size
    )
    SELECT
      count(*)::integer,
      (array_agg(created_at ORDER BY created_at, id))[1],
      (array_agg(id ORDER BY created_at, id))[1],
      (array_agg(created_at ORDER BY created_at DESC, id DESC))[1],
      (array_agg(id ORDER BY created_at DESC, id DESC))[1]
    INTO
      _batch_count,
      _batch_first_at,
      _batch_first_id,
      _batch_last_at,
      _batch_last_id
    FROM batch_events;

    IF _batch_count > 0 THEN
      -- Bounded overlap: never scan from a historical cursor through now.
      _affected_start := _batch_first_at - _overlap;
      _affected_end := _batch_last_at + interval '1 microsecond';
    ELSE
      -- A no-op pass only checks the recent raw append window for late commits.
      _affected_start := _now - _overlap;
      _affected_end := _now + interval '1 microsecond';
    END IF;

    SELECT array_agg(DISTINCT events.session_id ORDER BY events.session_id)
    INTO _affected_sessions
    FROM public.tracking_events events
    WHERE events.company_id = _company_id
      AND events.tracking_source = 'public'
      AND events.session_id IS NOT NULL
      AND events.event_name IN (
        'page_view', 'date_select', 'time_select',
        'form_fill', 'lead_captured', 'reservation_created'
      )
      AND events.created_at >= _affected_start
      AND events.created_at < _affected_end;

    _projected_count := public._rebuild_tracking_funnel_sessions(
      _company_id,
      _affected_sessions
    );

    IF _batch_count > 0 THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.tracking_events events
        WHERE events.company_id = _company_id
          AND events.tracking_source = 'public'
          AND events.event_name IN (
            'page_view', 'date_select', 'time_select',
            'form_fill', 'lead_captured', 'reservation_created'
          )
          AND (
            events.created_at > _batch_last_at
            OR (events.created_at = _batch_last_at AND events.id > _batch_last_id)
          )
      ) INTO _has_more;
    END IF;

    UPDATE public.tracking_funnel_projection_state
    SET
      cursor_created_at = CASE
        WHEN _batch_count > 0 THEN _batch_last_at
        ELSE cursor_created_at
      END,
      cursor_event_id = CASE
        WHEN _batch_count > 0 THEN _batch_last_id
        ELSE cursor_event_id
      END,
      covered_through_at = CASE
        WHEN _has_more THEN _batch_last_at
        ELSE _now
      END,
      is_ready = NOT _has_more,
      processed_events = processed_events + _batch_count,
      last_completed_at = _now,
      next_attempt_at = '-infinity'::timestamptz,
      consecutive_errors = 0,
      last_error = NULL,
      updated_at = _now
    WHERE company_id = _company_id;

    RETURN jsonb_build_object(
      'status', CASE WHEN _has_more THEN 'partial' ELSE 'ready' END,
      'company_id', _company_id,
      'events_processed', _batch_count,
      'sessions_projected', _projected_count,
      'has_more', _has_more,
      'cursor_created_at', COALESCE(_batch_last_at, _cursor_at),
      'affected_window_start', _affected_start,
      'affected_window_end', _affected_end,
      'covered_through_at', CASE WHEN _has_more THEN _batch_last_at ELSE _now END
    );
  EXCEPTION
    WHEN OTHERS THEN
      UPDATE public.tracking_funnel_projection_state
      SET
        is_ready = false,
        consecutive_errors = consecutive_errors + 1,
        last_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
        next_attempt_at = clock_timestamp()
          + make_interval(secs => LEAST(
              3600,
              30 * (1 << LEAST(consecutive_errors, 7))
            )),
        updated_at = clock_timestamp()
      WHERE company_id = _company_id;

      RETURN jsonb_build_object(
        'status', 'error',
        'company_id', _company_id,
        'sqlstate', SQLSTATE,
        'error', left(SQLERRM, 500)
      );
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public._run_tracking_funnel_projection(
  _company_limit integer DEFAULT 25,
  _batch_size integer DEFAULT 2000,
  _overlap interval DEFAULT interval '30 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _company record;
  _result jsonb;
  _results jsonb := '[]'::jsonb;
  _processed_companies integer := 0;
  _global_ready boolean := false;
  _global_covered_through timestamptz;
  _now timestamptz := clock_timestamp();
BEGIN
  IF _company_limit IS NULL OR _company_limit < 1 OR _company_limit > 200 THEN
    RAISE EXCEPTION 'company_limit deve estar entre 1 e 200.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-projector-global', 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked', 'companies', '[]'::jsonb);
  END IF;

  -- Initial historical discovery is performed once in the base migration.
  -- Recurring discovery is bounded and cannot turn readiness into a full-log
  -- scan when read_model rollout is enabled.
  INSERT INTO public.tracking_funnel_projection_state(company_id)
  SELECT DISTINCT events.company_id
  FROM public.tracking_events events
  WHERE events.tracking_source = 'public'
    AND events.created_at >= _now - interval '2 days'
    AND events.event_name IN (
      'page_view', 'date_select', 'time_select',
      'form_fill', 'lead_captured', 'reservation_created'
    )
  ON CONFLICT (company_id) DO NOTHING;

  -- Oldest-started eligible tenants go first.  Updating last_started_at in the
  -- company function creates round-robin behavior even when limit < tenants;
  -- backoff removes a failing tenant temporarily instead of starving others.
  FOR _company IN
    SELECT state.company_id
    FROM public.tracking_funnel_projection_state state
    WHERE state.next_attempt_at <= _now
    ORDER BY state.last_started_at NULLS FIRST, state.company_id
    LIMIT _company_limit
  LOOP
    BEGIN
      _result := public._project_tracking_funnel_company_batch(
        _company.company_id,
        _batch_size,
        _overlap
      );
    EXCEPTION
      WHEN OTHERS THEN
        UPDATE public.tracking_funnel_projection_state
        SET
          is_ready = false,
          consecutive_errors = consecutive_errors + 1,
          last_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
          next_attempt_at = clock_timestamp()
            + make_interval(secs => LEAST(
                3600,
                30 * (1 << LEAST(consecutive_errors, 7))
              )),
          updated_at = clock_timestamp()
        WHERE company_id = _company.company_id;

        _result := jsonb_build_object(
          'status', 'error',
          'company_id', _company.company_id,
          'sqlstate', SQLSTATE,
          'error', left(SQLERRM, 500)
        );
    END;

    _results := _results || jsonb_build_array(_result);
    _processed_companies := _processed_companies + 1;
  END LOOP;

  SELECT
    COALESCE(bool_and(
      state.is_ready
      AND state.last_error IS NULL
      AND state.last_reconciliation_error IS NULL
      AND state.projection_version = 1
      AND state.covered_through_at IS NOT NULL
    ), true),
    min(state.covered_through_at)
  INTO _global_ready, _global_covered_through
  FROM public.tracking_funnel_projection_state state;

  UPDATE public.tracking_funnel_global_projection_state
  SET
    is_ready = _global_ready,
    covered_through_at = CASE
      WHEN _global_ready THEN COALESCE(_global_covered_through, _now)
      ELSE NULL
    END,
    updated_at = _now
  WHERE singleton;

  RETURN jsonb_build_object(
    'status', 'ok',
    'processed_companies', _processed_companies,
    'companies', _results,
    'finished_at', clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._run_tracking_funnel_reconciliation(
  _lookback interval DEFAULT interval '7 days',
  _company_limit integer DEFAULT 200,
  _max_sessions_per_company integer DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _company record;
  _result jsonb;
  _results jsonb := '[]'::jsonb;
  _total integer := 0;
  _now timestamptz := clock_timestamp();
BEGIN
  IF _lookback IS NULL OR _lookback < interval '1 hour' OR _lookback > interval '366 days' THEN
    RAISE EXCEPTION 'lookback deve estar entre 1 hora e 366 dias.' USING ERRCODE = '22023';
  END IF;

  IF _company_limit IS NULL OR _company_limit < 1 OR _company_limit > 1000 THEN
    RAISE EXCEPTION 'company_limit deve estar entre 1 e 1000.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-reconciler-global', 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked');
  END IF;

  FOR _company IN
    SELECT state.company_id
    FROM public.tracking_funnel_projection_state state
    WHERE state.next_reconciliation_attempt_at <= _now
    ORDER BY state.last_reconciliation_started_at NULLS FIRST, state.company_id
    LIMIT _company_limit
  LOOP
    BEGIN
      _result := public._reconcile_tracking_funnel_company_batch(
        _company.company_id,
        _lookback,
        _max_sessions_per_company
      );
    EXCEPTION
      WHEN OTHERS THEN
        UPDATE public.tracking_funnel_projection_state
        SET
          reconciliation_errors = reconciliation_errors + 1,
          last_reconciliation_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
          next_reconciliation_attempt_at = clock_timestamp()
            + make_interval(secs => LEAST(
                3600,
                30 * (1 << LEAST(reconciliation_errors, 7))
              )),
          updated_at = clock_timestamp()
        WHERE company_id = _company.company_id;

        _result := jsonb_build_object(
          'status', 'error',
          'company_id', _company.company_id,
          'sqlstate', SQLSTATE,
          'error', left(SQLERRM, 500)
        );
    END;

    _results := _results || jsonb_build_array(_result);
    _total := _total + COALESCE((_result ->> 'sessions_reconciled')::integer, 0);
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'ok',
    'sessions_reconciled', _total,
    'companies', _results,
    'finished_at', clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._tracking_funnel_company_read_model_ready(
  _company_id uuid,
  _required_through timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT
      state.is_ready
      AND state.last_error IS NULL
      AND state.last_reconciliation_error IS NULL
      AND state.projection_version = 1
      AND state.covered_through_at >=
        LEAST(_required_through, statement_timestamp()) - interval '5 minutes'
    FROM public.tracking_funnel_projection_state state
    WHERE state.company_id = _company_id
  ), false);
$$;

CREATE OR REPLACE FUNCTION public._tracking_funnel_global_read_model_ready(
  _required_through timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- State-table cardinality is tenant-sized, not event-sized.  Reading it here
  -- avoids a stale global snapshot after a direct tenant batch or repair error
  -- without ever scanning the historical event log.
  SELECT COALESCE(bool_and(
    state.is_ready
    AND state.last_error IS NULL
    AND state.last_reconciliation_error IS NULL
    AND state.projection_version = 1
    AND state.covered_through_at >=
      LEAST(_required_through, statement_timestamp()) - interval '5 minutes'
  ), true)
  FROM public.tracking_funnel_projection_state state;
$$;

COMMENT ON FUNCTION public._rebuild_tracking_funnel_sessions(uuid, uuid[])
IS 'Reconstrói sessões exatas ancoradas no primeiro page_view; nunca participa da captura ou da fila Meta.';

COMMENT ON FUNCTION public._project_tracking_funnel_company_batch(uuid, integer, interval)
IS 'Projeção assíncrona com cursor, overlap bruto limitado ao lote, backoff e erro persistido por empresa.';

COMMENT ON FUNCTION public._reconcile_tracking_funnel_company_batch(uuid, interval, integer)
IS 'Reconciliação diária paginada por sessão para correções e exclusões do log bruto.';

REVOKE ALL ON FUNCTION public._rebuild_tracking_funnel_sessions(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._reconcile_tracking_funnel_company(
  uuid, timestamptz, timestamptz, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._reconcile_tracking_funnel_company_batch(
  uuid, interval, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._project_tracking_funnel_company_batch(
  uuid, integer, interval
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._run_tracking_funnel_projection(integer, integer, interval)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._run_tracking_funnel_reconciliation(interval, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public._rebuild_tracking_funnel_sessions(uuid, uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public._reconcile_tracking_funnel_company(
  uuid, timestamptz, timestamptz, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public._reconcile_tracking_funnel_company_batch(
  uuid, interval, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public._project_tracking_funnel_company_batch(
  uuid, integer, interval
) TO service_role;
GRANT EXECUTE ON FUNCTION public._run_tracking_funnel_projection(integer, integer, interval)
  TO service_role;
GRANT EXECUTE ON FUNCTION public._run_tracking_funnel_reconciliation(interval, integer, integer)
  TO service_role;
