ALTER TABLE public.whatsapp_broadcast_recipients
  DROP CONSTRAINT IF EXISTS whatsapp_broadcast_recipients_status_check;

ALTER TABLE public.whatsapp_broadcast_recipients
  ADD CONSTRAINT whatsapp_broadcast_recipients_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped', 'cancelled'));

ALTER TABLE public.whatsapp_broadcast_recipients
  ADD COLUMN IF NOT EXISTS phone_normalized text
  GENERATED ALWAYS AS (right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 11)) STORED;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY broadcast_id, phone_normalized
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.whatsapp_broadcast_recipients
  WHERE phone_normalized <> ''
)
DELETE FROM public.whatsapp_broadcast_recipients r
USING ranked
WHERE r.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_phone_unique
  ON public.whatsapp_broadcast_recipients(broadcast_id, phone_normalized)
  WHERE phone_normalized <> '';

WITH stats AS (
  SELECT
    broadcast_id,
    count(*)::integer AS total_recipients,
    count(*) FILTER (WHERE status = 'sent')::integer AS sent_count,
    count(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
    count(*) FILTER (WHERE status = 'skipped')::integer AS skipped_count,
    count(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled_count
  FROM public.whatsapp_broadcast_recipients
  GROUP BY broadcast_id
)
UPDATE public.whatsapp_broadcasts b
SET
  total_recipients = COALESCE(stats.total_recipients, 0),
  sent_count = COALESCE(stats.sent_count, 0),
  failed_count = COALESCE(stats.failed_count, 0),
  skipped_count = COALESCE(stats.skipped_count, 0),
  cancelled_count = COALESCE(stats.cancelled_count, 0),
  updated_at = now()
FROM stats
WHERE b.id = stats.broadcast_id;

UPDATE public.whatsapp_broadcasts b
SET
  total_recipients = 0,
  sent_count = 0,
  failed_count = 0,
  skipped_count = 0,
  cancelled_count = 0,
  updated_at = now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.whatsapp_broadcast_recipients r
  WHERE r.broadcast_id = b.id
);
