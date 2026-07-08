-- Prioriza mensagens transacionais PlugueChat, como confirmacao de reserva
-- e notificacoes de fila, para nao ficarem atras de disparos em massa.

ALTER TABLE public.pluguechat_message_queue
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;

CREATE INDEX IF NOT EXISTS pluguechat_message_queue_status_priority_idx
  ON public.pluguechat_message_queue (status, priority, scheduled_for, created_at)
  WHERE status = 'pending';
