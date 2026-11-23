-- Inert until an operator configures this project's central account and new
-- opted-in financial records exist. The function only reconciles; it never
-- initiates a bank transfer or creates an opening balance for old payments.
SELECT cron.schedule('reconcile-reservation-settlements','*/5 * * * *',$job$
  SELECT CASE WHEN NULLIF(btrim(config.project_url),'') IS NOT NULL
    AND COALESCE((SELECT value FROM public.system_settings WHERE key='internal_job_secret' LIMIT 1),'')<>''
    AND EXISTS(SELECT 1 FROM public.reservation_payment_settlements)
  THEN net.http_post(
    url:=rtrim(config.project_url,'/')||'/functions/v1/reconcile-reservation-settlements',
    headers:=jsonb_build_object('Content-Type','application/json','x-job-secret',
      (SELECT value FROM public.system_settings WHERE key='internal_job_secret' LIMIT 1)),
    body:=jsonb_build_object('limit',25)
  ) ELSE NULL END AS request_id
  FROM public.platform_reservation_asaas_config config WHERE config.id=true;
$job$);
