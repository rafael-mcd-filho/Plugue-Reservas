-- Guarda o status real retornado pelo provedor para mensagens PlugueChat.
-- A primeira chamada pode apenas enfileirar no provedor; a entrega/falha final
-- vem do endpoint /chat/v1/message/{id}/status.

ALTER TABLE public.pluguechat_message_queue
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_status_url text,
  ADD COLUMN IF NOT EXISTS provider_status_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS pluguechat_message_queue_provider_queued_idx
  ON public.pluguechat_message_queue (provider_status_checked_at, expires_at)
  WHERE status = 'provider_queued';

ALTER TABLE public.pluguechat_message_logs
  ADD COLUMN IF NOT EXISTS queue_id uuid REFERENCES public.pluguechat_message_queue(id) ON DELETE SET NULL;

WITH candidate AS (
  SELECT DISTINCT ON (q.id)
    l.id AS log_id,
    q.id AS queue_id
  FROM public.pluguechat_message_logs l
  JOIN public.pluguechat_message_queue q
    ON q.company_id = l.company_id
   AND q.provider_message_id = l.provider_message_id
  WHERE l.queue_id IS NULL
    AND l.provider_message_id IS NOT NULL
  ORDER BY q.id, l.created_at DESC
)
UPDATE public.pluguechat_message_logs l
SET queue_id = candidate.queue_id
FROM candidate
WHERE l.id = candidate.log_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pluguechat_message_logs_queue_id_key'
      AND conrelid = 'public.pluguechat_message_logs'::regclass
  ) THEN
    ALTER TABLE public.pluguechat_message_logs
      ADD CONSTRAINT pluguechat_message_logs_queue_id_key UNIQUE (queue_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS pluguechat_message_logs_provider_message_idx
  ON public.pluguechat_message_logs (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
