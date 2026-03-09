
SELECT cron.schedule(
  'send-reservation-reminders',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/send-reminders',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkcHhxcWl1ZGlvdGFucnlidmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjk0OTksImV4cCI6MjA4ODY0NTQ5OX0.OeJWsYMXQSMqNz05eqfgceMj3iQNX0pQH-4gxKOaNhY"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
