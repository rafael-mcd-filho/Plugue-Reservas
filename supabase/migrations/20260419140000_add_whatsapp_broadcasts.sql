-- WhatsApp broadcast campaigns (marketing-style bulk sends)

CREATE TABLE IF NOT EXISTS public.whatsapp_broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  message text NOT NULL,
  image_url text,
  delay_min_seconds integer NOT NULL DEFAULT 20,
  delay_max_seconds integer NOT NULL DEFAULT 40,
  status text NOT NULL DEFAULT 'pending',
  filter_date_from date,
  filter_date_to date,
  filter_statuses text[] NOT NULL DEFAULT ARRAY[]::text[],
  total_recipients integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  cancelled_count integer NOT NULL DEFAULT 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_broadcasts_status_check
    CHECK (status IN ('pending', 'running', 'paused', 'cancelled', 'completed', 'failed')),
  CONSTRAINT whatsapp_broadcasts_delay_range_check
    CHECK (delay_min_seconds >= 0 AND delay_max_seconds >= delay_min_seconds)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_broadcasts_company_created_at
  ON public.whatsapp_broadcasts(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_broadcasts_status
  ON public.whatsapp_broadcasts(status)
  WHERE status IN ('pending', 'running');

ALTER TABLE public.whatsapp_broadcasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view broadcasts" ON public.whatsapp_broadcasts;
CREATE POLICY "Company staff can view broadcasts"
ON public.whatsapp_broadcasts
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can create broadcasts" ON public.whatsapp_broadcasts;
CREATE POLICY "Company admins can create broadcasts"
ON public.whatsapp_broadcasts
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can update broadcasts" ON public.whatsapp_broadcasts;
CREATE POLICY "Company admins can update broadcasts"
ON public.whatsapp_broadcasts
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can delete broadcasts" ON public.whatsapp_broadcasts;
CREATE POLICY "Company admins can delete broadcasts"
ON public.whatsapp_broadcasts
FOR DELETE
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

CREATE TABLE IF NOT EXISTS public.whatsapp_broadcast_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL REFERENCES public.whatsapp_broadcasts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  phone text NOT NULL,
  guest_name text,
  status text NOT NULL DEFAULT 'pending',
  error_details text,
  message_log_id uuid,
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_broadcast_recipients_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status
  ON public.whatsapp_broadcast_recipients(broadcast_id, status);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_company
  ON public.whatsapp_broadcast_recipients(company_id);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_pending
  ON public.whatsapp_broadcast_recipients(broadcast_id)
  WHERE status = 'pending';

ALTER TABLE public.whatsapp_broadcast_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view broadcast recipients" ON public.whatsapp_broadcast_recipients;
CREATE POLICY "Company staff can view broadcast recipients"
ON public.whatsapp_broadcast_recipients
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can insert broadcast recipients" ON public.whatsapp_broadcast_recipients;
CREATE POLICY "Company admins can insert broadcast recipients"
ON public.whatsapp_broadcast_recipients
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can delete broadcast recipients" ON public.whatsapp_broadcast_recipients;
CREATE POLICY "Company admins can delete broadcast recipients"
ON public.whatsapp_broadcast_recipients
FOR DELETE
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

CREATE OR REPLACE FUNCTION public.touch_whatsapp_broadcasts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_whatsapp_broadcasts_updated_at ON public.whatsapp_broadcasts;
CREATE TRIGGER trg_touch_whatsapp_broadcasts_updated_at
BEFORE UPDATE ON public.whatsapp_broadcasts
FOR EACH ROW
EXECUTE FUNCTION public.touch_whatsapp_broadcasts_updated_at();

DROP TRIGGER IF EXISTS trg_touch_whatsapp_broadcast_recipients_updated_at ON public.whatsapp_broadcast_recipients;
CREATE TRIGGER trg_touch_whatsapp_broadcast_recipients_updated_at
BEFORE UPDATE ON public.whatsapp_broadcast_recipients
FOR EACH ROW
EXECUTE FUNCTION public.touch_whatsapp_broadcasts_updated_at();

-- Storage: allow company admins to upload broadcast images
DROP POLICY IF EXISTS "Company admins can upload broadcast assets" ON storage.objects;
CREATE POLICY "Company admins can upload broadcast assets"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'system-assets'
  AND (storage.foldername(name))[1] = 'whatsapp-broadcasts'
  AND (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'admin'::public.app_role
        AND ur.company_id::text = (storage.foldername(name))[2]
    )
  )
);

DROP POLICY IF EXISTS "Company admins can delete broadcast assets" ON storage.objects;
CREATE POLICY "Company admins can delete broadcast assets"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'system-assets'
  AND (storage.foldername(name))[1] = 'whatsapp-broadcasts'
  AND (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'admin'::public.app_role
        AND ur.company_id::text = (storage.foldername(name))[2]
    )
  )
);
