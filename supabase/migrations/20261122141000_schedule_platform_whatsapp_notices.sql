-- No fixed project/credentials and no dispatch until a superadmin queues notices.
-- The API stores SUPABASE_URL under platform_notices_project_url on first use.
DO $schedule$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.schedule('process-platform-whatsapp-notices','* * * * *',$job$
      SELECT CASE WHEN endpoint.url ~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/?$'
        AND secret.value IS NOT NULL AND length(secret.value)>0
        AND EXISTS(SELECT 1 FROM public.platform_whatsapp_notices WHERE status='queued' OR (status='processing' AND lease_expires_at<=now()))
      THEN net.http_post(
        url:=rtrim(endpoint.url,'/')||'/functions/v1/process-platform-whatsapp-notices',
        headers:=jsonb_build_object('Content-Type','application/json','x-job-secret',secret.value),
        body:=jsonb_build_object('limit',3),timeout_milliseconds:=90000
      ) ELSE NULL END request_id
      FROM (SELECT value url FROM public.system_settings WHERE key='platform_notices_project_url' LIMIT 1) endpoint
      CROSS JOIN (SELECT value FROM public.system_settings WHERE key='internal_job_secret' LIMIT 1) secret;
    $job$);
  END IF;
END;
$schedule$;
