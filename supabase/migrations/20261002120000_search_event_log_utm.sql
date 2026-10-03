-- Invoker keeps the existing tenant/staff RLS policies on both tables.
CREATE OR REPLACE FUNCTION public.search_company_event_log_utm(
  _company_id uuid,
  _term text DEFAULT '',
  _utm_filters jsonb DEFAULT '{}'::jsonb,
  _event_name text DEFAULT NULL,
  _start timestamptz DEFAULT NULL,
  _end timestamptz DEFAULT NULL
)
RETURNS SETOF public.tracking_events
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.tracking_events e
  LEFT JOIN public.tracking_sessions s
    ON s.id = e.session_id AND s.company_id = e.company_id
  WHERE e.company_id = _company_id
    AND (_event_name IS NULL OR e.event_name = _event_name)
    AND (_start IS NULL OR e.occurred_at >= _start)
    AND (_end IS NULL OR e.occurred_at <= _end)
    AND (
      COALESCE(btrim(_term), '') = '' OR EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'
        ]) AS keys(key)
        WHERE strpos(lower(COALESCE(
          NULLIF(btrim(e.metadata ->> key), ''), to_jsonb(s) ->> key, ''
        )), lower(btrim(_term))) > 0
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each_text(COALESCE(_utm_filters, '{}'::jsonb)) f
      WHERE f.key IN ('utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term')
        AND lower(COALESCE(
          NULLIF(btrim(e.metadata ->> f.key), ''), to_jsonb(s) ->> f.key, ''
        )) <> lower(btrim(f.value))
    )
  ORDER BY e.occurred_at DESC, e.id DESC
  LIMIT 100;
$$;

REVOKE ALL ON FUNCTION public.search_company_event_log_utm(uuid, text, jsonb, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_company_event_log_utm(uuid, text, jsonb, text, timestamptz, timestamptz) TO authenticated;
