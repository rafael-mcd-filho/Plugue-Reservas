CREATE OR REPLACE FUNCTION public.refresh_whatsapp_broadcast_counts(_broadcast_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _broadcast_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.whatsapp_broadcasts AS b
  SET
    total_recipients = COALESCE(stats.total_recipients, 0),
    sent_count = COALESCE(stats.sent_count, 0),
    failed_count = COALESCE(stats.failed_count, 0),
    skipped_count = COALESCE(stats.skipped_count, 0),
    cancelled_count = COALESCE(stats.cancelled_count, 0),
    updated_at = now()
  FROM (
    SELECT
      count(*)::integer AS total_recipients,
      count(*) FILTER (WHERE status = 'sent')::integer AS sent_count,
      count(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
      count(*) FILTER (WHERE status = 'skipped')::integer AS skipped_count,
      count(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled_count
    FROM public.whatsapp_broadcast_recipients
    WHERE broadcast_id = _broadcast_id
  ) AS stats
  WHERE b.id = _broadcast_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_whatsapp_broadcast_counts_from_recipient()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_whatsapp_broadcast_counts(OLD.broadcast_id);
    RETURN OLD;
  END IF;

  PERFORM public.refresh_whatsapp_broadcast_counts(NEW.broadcast_id);

  IF TG_OP = 'UPDATE' AND OLD.broadcast_id IS DISTINCT FROM NEW.broadcast_id THEN
    PERFORM public.refresh_whatsapp_broadcast_counts(OLD.broadcast_id);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_whatsapp_broadcast_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_whatsapp_broadcast_counts_from_recipient() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_sync_whatsapp_broadcast_counts ON public.whatsapp_broadcast_recipients;
CREATE TRIGGER trg_sync_whatsapp_broadcast_counts
AFTER INSERT OR UPDATE OF broadcast_id, status OR DELETE
ON public.whatsapp_broadcast_recipients
FOR EACH ROW
EXECUTE FUNCTION public.sync_whatsapp_broadcast_counts_from_recipient();

CREATE OR REPLACE FUNCTION public.get_whatsapp_broadcast_stats(_broadcast_ids uuid[])
RETURNS TABLE (
  broadcast_id uuid,
  total_recipients integer,
  sent_count integer,
  failed_count integer,
  skipped_count integer,
  cancelled_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    r.broadcast_id,
    count(*)::integer AS total_recipients,
    count(*) FILTER (WHERE r.status = 'sent')::integer AS sent_count,
    count(*) FILTER (WHERE r.status = 'failed')::integer AS failed_count,
    count(*) FILTER (WHERE r.status = 'skipped')::integer AS skipped_count,
    count(*) FILTER (WHERE r.status = 'cancelled')::integer AS cancelled_count
  FROM public.whatsapp_broadcast_recipients AS r
  WHERE r.broadcast_id = ANY(COALESCE(_broadcast_ids, ARRAY[]::uuid[]))
  GROUP BY r.broadcast_id;
$$;

REVOKE ALL ON FUNCTION public.get_whatsapp_broadcast_stats(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_whatsapp_broadcast_stats(uuid[]) TO authenticated, service_role;

SELECT public.refresh_whatsapp_broadcast_counts(id)
FROM public.whatsapp_broadcasts;
