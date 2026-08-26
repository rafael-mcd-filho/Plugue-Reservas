-- Async company deletion pipeline -- batching engine.
--
-- Mirrors the hardened tracking-funnel projector pattern exactly
-- (supabase/migrations/20260820121500_harden_tracking_funnel_projection.sql):
-- per-company advisory lock, FOR UPDATE on the state row, exponential
-- backoff on error, a global-lock runner looping eligible rows, scheduled
-- every minute via pg_cron. Internal functions are service_role-only -- no
-- authenticated session, including a superadmin's own browser session, can
-- invoke a raw batch-delete directly; only the thin request/cancel RPCs
-- (added in the next migration) and this cron path can.

CREATE OR REPLACE FUNCTION public._process_company_deletion_batch(
  _request_id uuid,
  _batch_size integer DEFAULT 3000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '55s'
AS $$
DECLARE
  _company_id uuid;
  _status text;
  _grace_period_ends_at timestamptz;
  _phase_index integer;
  _external_teardown_result jsonb;
  _external_teardown_requested_at timestamptz;
  _requested_by uuid;
  _requested_reason text;
  _confirmation_text text;
  _company_name_snapshot text;
  _deleted_counts jsonb;
  _now timestamptz := clock_timestamp();
  _table_name text;
  _column_name text;
  _max_phase_index integer;
  _deleted_rows integer;
  _job_secret text;
  _audit_id uuid;
BEGIN
  IF _batch_size IS NULL OR _batch_size < 1 OR _batch_size > 20000 THEN
    RAISE EXCEPTION 'batch_size deve estar entre 1 e 20000.' USING ERRCODE = '22023';
  END IF;

  SELECT request.company_id
  INTO _company_id
  FROM public.company_deletion_requests request
  WHERE request.id = _request_id;

  IF _company_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found', 'request_id', _request_id);
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('company-deletion:' || _company_id::text, 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked', 'request_id', _request_id);
  END IF;

  -- Lock the request row before reading/advancing phase and counters -- a
  -- concurrent cancel must not be a lost update against an in-flight batch.
  SELECT
    request.status, request.grace_period_ends_at, request.phase_index,
    request.external_teardown_result, request.external_teardown_requested_at,
    request.requested_by, request.requested_reason,
    request.confirmation_text, request.company_name_snapshot, request.deleted_counts
  INTO
    _status, _grace_period_ends_at, _phase_index,
    _external_teardown_result, _external_teardown_requested_at,
    _requested_by, _requested_reason,
    _confirmation_text, _company_name_snapshot, _deleted_counts
  FROM public.company_deletion_requests request
  WHERE request.id = _request_id
  FOR UPDATE;

  IF _status NOT IN ('grace_period', 'running') THEN
    RETURN jsonb_build_object('status', _status, 'request_id', _request_id, 'note', 'not eligible');
  END IF;

  IF _status = 'grace_period' THEN
    IF _now < _grace_period_ends_at THEN
      RETURN jsonb_build_object('status', 'grace_period', 'request_id', _request_id);
    END IF;

    UPDATE public.company_deletion_requests
    SET status = 'running', started_processing_at = _now, updated_at = _now
    WHERE id = _request_id;
    _status := 'running';
  END IF;

  BEGIN
    SELECT max(order_row.phase_index) INTO _max_phase_index
    FROM public.company_deletion_phase_order order_row;

    IF _phase_index <= _max_phase_index THEN
      SELECT order_row.table_name, order_row.company_id_column
      INTO _table_name, _column_name
      FROM public.company_deletion_phase_order order_row
      WHERE order_row.phase_index = _phase_index;

      EXECUTE format(
        'DELETE FROM public.%I t WHERE %I = $1 AND ctid = ANY (ARRAY(' ||
        'SELECT ctid FROM public.%I WHERE %I = $1 FOR UPDATE SKIP LOCKED LIMIT $2' ||
        '))',
        _table_name, _column_name, _table_name, _column_name
      ) USING _company_id, _batch_size;
      GET DIAGNOSTICS _deleted_rows = ROW_COUNT;

      _deleted_counts := _deleted_counts
        || jsonb_build_object(_table_name, COALESCE((_deleted_counts ->> _table_name)::integer, 0) + _deleted_rows);

      UPDATE public.company_deletion_requests
      SET
        phase_index = CASE WHEN _deleted_rows = 0 THEN _phase_index + 1 ELSE _phase_index END,
        phase = _table_name,
        deleted_counts = _deleted_counts,
        attempts = attempts + 1,
        consecutive_errors = 0,
        last_error = NULL,
        next_attempt_at = '-infinity'::timestamptz,
        updated_at = _now
      WHERE id = _request_id;

      RETURN jsonb_build_object(
        'status', 'running', 'request_id', _request_id,
        'phase', _table_name, 'deleted_this_tick', _deleted_rows
      );
    END IF;

    -- All table phases drained. Desprovisiona WhatsApp/Storage antes da
    -- exclusão final; Asaas é deliberadamente fora do escopo automatizado.
    IF COALESCE(_external_teardown_result ->> 'status', 'not_started') <> 'ok' THEN
      IF _external_teardown_requested_at IS NULL
        OR _external_teardown_requested_at < _now - interval '3 minutes' THEN
        SELECT value INTO _job_secret
        FROM public.system_settings
        WHERE key = 'internal_job_secret';

        IF COALESCE(_job_secret, '') <> '' THEN
          PERFORM net.http_post(
            url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/teardown-company-external-resources',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'x-job-secret', _job_secret
            ),
            body := jsonb_build_object('request_id', _request_id, 'company_id', _company_id)
          );
        END IF;

        UPDATE public.company_deletion_requests
        SET
          external_teardown_requested_at = _now,
          phase = 'external_teardown',
          updated_at = _now
        WHERE id = _request_id;
      END IF;

      RETURN jsonb_build_object('status', 'running', 'request_id', _request_id, 'phase', 'external_teardown');
    END IF;

    -- Teardown confirmed ok by the edge function. Final delete: children are
    -- already drained, so the remaining cascade only has to cover the small
    -- SET-NULL-only and any accidentally-omitted tables.
    SELECT company.name INTO _company_name_snapshot
    FROM public.companies company
    WHERE company.id = _company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      UPDATE public.company_deletion_requests
      SET status = 'completed', phase = 'already_deleted', completed_at = _now, updated_at = _now
      WHERE id = _request_id;
      RETURN jsonb_build_object('status', 'completed', 'request_id', _request_id, 'note', 'already_deleted');
    END IF;

    DELETE FROM public.companies WHERE id = _company_id;

    INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, details)
    VALUES (
      _requested_by,
      'company_deleted_permanently',
      'company',
      _company_id,
      jsonb_build_object(
        'company_name', _company_name_snapshot,
        'reason', _requested_reason,
        'confirmation_text', _confirmation_text,
        'deletion_request_id', _request_id,
        'deleted_counts', _deleted_counts,
        'external_teardown_result', _external_teardown_result
      )
    )
    RETURNING id INTO _audit_id;

    UPDATE public.company_deletion_requests
    SET status = 'completed', phase = 'completed', completed_at = _now, updated_at = _now
    WHERE id = _request_id;

    RETURN jsonb_build_object('status', 'completed', 'request_id', _request_id, 'audit_log_id', _audit_id);
  EXCEPTION
    WHEN OTHERS THEN
      UPDATE public.company_deletion_requests
      SET
        consecutive_errors = consecutive_errors + 1,
        last_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
        status = CASE WHEN consecutive_errors + 1 >= 10 THEN 'needs_attention' ELSE status END,
        next_attempt_at = clock_timestamp()
          + make_interval(secs => LEAST(3600, 30 * (1 << LEAST(consecutive_errors, 7)))),
        updated_at = clock_timestamp()
      WHERE id = _request_id;

      RETURN jsonb_build_object(
        'status', 'error', 'request_id', _request_id,
        'sqlstate', SQLSTATE, 'error', left(SQLERRM, 500)
      );
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public._run_company_deletion_pipeline(
  _request_limit integer DEFAULT 10,
  _batch_size integer DEFAULT 3000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _pipeline_enabled text;
  _request record;
  _result jsonb;
  _results jsonb := '[]'::jsonb;
  _processed integer := 0;
  _now timestamptz := clock_timestamp();
BEGIN
  IF _request_limit IS NULL OR _request_limit < 1 OR _request_limit > 100 THEN
    RAISE EXCEPTION 'request_limit deve estar entre 1 e 100.' USING ERRCODE = '22023';
  END IF;

  SELECT value INTO _pipeline_enabled
  FROM public.system_settings
  WHERE key = 'company_deletion_pipeline_enabled';

  IF COALESCE(_pipeline_enabled, 'false') <> 'true' THEN
    RETURN jsonb_build_object('status', 'disabled');
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('company-deletion-runner-global', 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked');
  END IF;

  FOR _request IN
    SELECT request.id
    FROM public.company_deletion_requests request
    WHERE request.status IN ('grace_period', 'running')
      AND request.next_attempt_at <= _now
    ORDER BY request.next_attempt_at, request.id
    LIMIT _request_limit
  LOOP
    BEGIN
      _result := public._process_company_deletion_batch(_request.id, _batch_size);
    EXCEPTION
      WHEN OTHERS THEN
        _result := jsonb_build_object(
          'status', 'error', 'request_id', _request.id,
          'sqlstate', SQLSTATE, 'error', left(SQLERRM, 500)
        );
    END;

    _results := _results || jsonb_build_array(_result);
    _processed := _processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'ok', 'processed_requests', _processed,
    'requests', _results, 'finished_at', clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION public._process_company_deletion_batch(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._run_company_deletion_pipeline(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public._process_company_deletion_batch(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public._run_company_deletion_pipeline(integer, integer) TO service_role;

INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('company_deletion_pipeline_enabled', 'false', now())
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  _job_id bigint;
BEGIN
  SELECT jobid INTO _job_id FROM cron.job WHERE jobname = 'process-company-deletion-pipeline' LIMIT 1;
  IF _job_id IS NOT NULL THEN
    PERFORM cron.unschedule(_job_id);
  END IF;
END;
$$;

-- Scheduled unconditionally; the runner itself checks the
-- company_deletion_pipeline_enabled flag and no-ops when it's off, so
-- toggling the flag (a plain UPDATE, no migration/deploy) is enough to turn
-- the whole pipeline on or off.
SELECT cron.schedule(
  'process-company-deletion-pipeline',
  '*/1 * * * *',
  $job$
    SELECT public._run_company_deletion_pipeline(10, 3000);
  $job$
);
