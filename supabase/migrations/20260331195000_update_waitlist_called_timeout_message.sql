UPDATE public.automation_settings
SET
  message_template = replace(message_template, '10 minutos', '5 minutos'),
  updated_at = now()
WHERE type = 'waitlist_called'
  AND message_template ILIKE '%10 minutos%';
