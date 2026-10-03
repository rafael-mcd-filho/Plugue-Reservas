-- Check the same staff permissions once, before scanning the tenant events.
CREATE OR REPLACE FUNCTION public.search_company_event_log_utm(
  _company_id uuid,
  _term text DEFAULT '',
  _utm_filters jsonb DEFAULT '{}'::jsonb,
  _event_name text DEFAULT NULL,
  _start timestamptz DEFAULT NULL,
  _end timestamptz DEFAULT NULL
)
RETURNS SETOF public.tracking_events
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role_in_company(auth.uid(), 'admin', _company_id)
    OR public.has_role_in_company(auth.uid(), 'operator', _company_id)
    OR public.has_role(auth.uid(), 'superadmin')
  ) THEN
    RAISE EXCEPTION 'Access denied to company event log' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
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
          NULLIF(btrim(e.metadata ->> key), ''), CASE key WHEN 'utm_source' THEN s.utm_source WHEN 'utm_medium' THEN s.utm_medium WHEN 'utm_campaign' THEN s.utm_campaign WHEN 'utm_content' THEN s.utm_content WHEN 'utm_term' THEN s.utm_term END, ''
        )), lower(btrim(_term))) > 0
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each_text(COALESCE(_utm_filters, '{}'::jsonb)) f
      WHERE f.key IN ('utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term')
        AND lower(COALESCE(
          NULLIF(btrim(e.metadata ->> f.key), ''), CASE f.key WHEN 'utm_source' THEN s.utm_source WHEN 'utm_medium' THEN s.utm_medium WHEN 'utm_campaign' THEN s.utm_campaign WHEN 'utm_content' THEN s.utm_content WHEN 'utm_term' THEN s.utm_term END, ''
        )) <> lower(btrim(f.value))
    )
  ORDER BY e.occurred_at DESC, e.id DESC
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.search_company_event_log_utm(uuid, text, jsonb, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_company_event_log_utm(uuid, text, jsonb, text, timestamptz, timestamptz) TO authenticated;
