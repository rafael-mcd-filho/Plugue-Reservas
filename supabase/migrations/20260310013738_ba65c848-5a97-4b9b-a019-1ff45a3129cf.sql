CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
  'check-whatsapp-status-every-10min',
  '*/10 * * * *',
  $$
  SELECT
    net.http_post(
        url:='https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/check-whatsapp-status',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkcHhxcWl1ZGlvdGFucnlidmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjk0OTksImV4cCI6MjA4ODY0NTQ5OX0.OeJWsYMXQSMqNz05eqfgceMj3iQNX0pQH-4gxKOaNhY"}'::jsonb,
        body:='{}'::jsonb
    ) as request_id;
  $$
);