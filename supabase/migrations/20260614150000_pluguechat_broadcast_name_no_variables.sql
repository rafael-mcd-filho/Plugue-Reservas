-- Store an operator-facing name for PlugueChat broadcasts separately from the
-- provider template id/name. PlugueChat broadcasts no longer use template
-- variables; recipients only need a phone number.

ALTER TABLE public.pluguechat_broadcasts
  ADD COLUMN IF NOT EXISTS name text;

UPDATE public.pluguechat_broadcasts
SET name = COALESCE(NULLIF(name, ''), NULLIF(template_name, ''), template_id)
WHERE name IS NULL OR name = '';

COMMENT ON COLUMN public.pluguechat_broadcasts.name
  IS 'Internal display name for the PlugueChat broadcast.';
