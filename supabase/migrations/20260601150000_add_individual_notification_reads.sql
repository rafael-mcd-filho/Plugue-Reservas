-- Registra os destinatarios no momento do envio e controla leitura por usuario.
-- Os campos is_read/read_at de notifications passam a representar leitura por
-- todos os destinatarios, mantendo compatibilidade com o painel do superadmin.

CREATE TABLE IF NOT EXISTS public.notification_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  recipient_name text NOT NULL,
  recipient_email text,
  recipient_roles text[] NOT NULL DEFAULT '{}'::text[],
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_recipients_user_notification
ON public.notification_recipients(user_id, notification_id);

CREATE INDEX IF NOT EXISTS idx_notification_recipients_notification_read
ON public.notification_recipients(notification_id, read_at);

ALTER TABLE public.notification_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmins can view notification recipients" ON public.notification_recipients;
CREATE POLICY "Superadmins can view notification recipients"
ON public.notification_recipients
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'superadmin'::public.app_role));

DROP POLICY IF EXISTS "Users can view own notification recipient rows" ON public.notification_recipients;
CREATE POLICY "Users can view own notification recipient rows"
ON public.notification_recipients
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON public.notification_recipients FROM anon, authenticated;
GRANT SELECT ON public.notification_recipients TO authenticated;

CREATE OR REPLACE FUNCTION public.capture_notification_recipients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notification_recipients (
    notification_id,
    company_id,
    user_id,
    recipient_name,
    recipient_email,
    recipient_roles,
    read_at
  )
  SELECT
    NEW.id,
    NEW.company_id,
    ur.user_id,
    COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(COALESCE(p.email, '')), ''), 'Usuario'),
    p.email,
    array_agg(DISTINCT ur.role::text ORDER BY ur.role::text),
    CASE WHEN NEW.is_read THEN COALESCE(NEW.read_at, NEW.created_at, now()) ELSE NULL END
  FROM public.user_roles ur
  JOIN public.profiles p ON p.id = ur.user_id
  WHERE ur.company_id = NEW.company_id
    AND ur.role IN ('admin'::public.app_role, 'operator'::public.app_role)
    AND COALESCE(p.is_active, true)
  GROUP BY ur.user_id, p.full_name, p.email
  ON CONFLICT (notification_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_notification_recipients() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_capture_notification_recipients ON public.notifications;
CREATE TRIGGER trg_capture_notification_recipients
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.capture_notification_recipients();

-- Preserva o estado dos avisos existentes. Avisos ja lidos nao devem voltar a
-- aparecer para todos os usuarios depois da migracao.
INSERT INTO public.notification_recipients (
  notification_id,
  company_id,
  user_id,
  recipient_name,
  recipient_email,
  recipient_roles,
  read_at,
  created_at
)
SELECT
  n.id,
  n.company_id,
  ur.user_id,
  COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(COALESCE(p.email, '')), ''), 'Usuario'),
  p.email,
  array_agg(DISTINCT ur.role::text ORDER BY ur.role::text),
  CASE WHEN n.is_read THEN COALESCE(n.read_at, n.created_at) ELSE NULL END,
  n.created_at
FROM public.notifications n
JOIN public.user_roles ur ON ur.company_id = n.company_id
JOIN public.profiles p ON p.id = ur.user_id
WHERE n.company_id IS NOT NULL
  AND ur.role IN ('admin'::public.app_role, 'operator'::public.app_role)
  AND COALESCE(p.is_active, true)
GROUP BY n.id, n.company_id, n.is_read, n.read_at, n.created_at, ur.user_id, p.full_name, p.email
ON CONFLICT (notification_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.refresh_notification_read_summary(_notification_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _recipient_count integer;
  _read_count integer;
  _last_read_at timestamptz;
BEGIN
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE nr.read_at IS NOT NULL)::integer,
    max(nr.read_at)
  INTO
    _recipient_count,
    _read_count,
    _last_read_at
  FROM public.notification_recipients nr
  WHERE nr.notification_id = _notification_id;

  UPDATE public.notifications n
  SET
    is_read = _recipient_count > 0 AND _read_count = _recipient_count,
    read_at = CASE
      WHEN _recipient_count > 0 AND _read_count = _recipient_count THEN _last_read_at
      ELSE NULL
    END
  WHERE n.id = _notification_id;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_notification_read_summary(uuid) FROM PUBLIC;

DO $$
DECLARE
  _notification_id uuid;
BEGIN
  FOR _notification_id IN
    SELECT n.id
    FROM public.notifications n
  LOOP
    PERFORM public.refresh_notification_read_summary(_notification_id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(_notification_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _notification_id uuid;
  _updated_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  IF _notification_ids IS NULL OR array_length(_notification_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.notification_recipients nr
  SET read_at = COALESCE(nr.read_at, now())
  WHERE nr.notification_id = ANY(_notification_ids)
    AND nr.user_id = auth.uid();

  GET DIAGNOSTICS _updated_count = ROW_COUNT;

  FOR _notification_id IN
    SELECT DISTINCT nr.notification_id
    FROM public.notification_recipients nr
    WHERE nr.notification_id = ANY(_notification_ids)
      AND nr.user_id = auth.uid()
  LOOP
    PERFORM public.refresh_notification_read_summary(_notification_id);
  END LOOP;

  RETURN _updated_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_company_notifications(
  _company_id uuid,
  _limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  title text,
  message text,
  image_url text,
  type text,
  is_read boolean,
  read_at timestamptz,
  created_by uuid,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
    OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, _company_id)
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND COALESCE(p.is_active, true)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  RETURN QUERY
  SELECT
    n.id,
    n.company_id,
    n.title,
    n.message,
    n.image_url,
    n.type,
    nr.read_at IS NOT NULL,
    nr.read_at,
    n.created_by,
    n.created_at
  FROM public.notification_recipients nr
  JOIN public.notifications n ON n.id = nr.notification_id
  WHERE nr.company_id = _company_id
    AND nr.user_id = auth.uid()
  ORDER BY n.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 20), 1), 100);
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_notifications(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_notifications(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_notification_delivery_summaries()
RETURNS TABLE (
  notification_id uuid,
  recipient_count integer,
  read_count integer,
  last_read_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'superadmin'::public.app_role) THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  RETURN QUERY
  SELECT
    n.id,
    count(nr.id)::integer,
    count(nr.read_at)::integer,
    max(nr.read_at)
  FROM public.notifications n
  LEFT JOIN public.notification_recipients nr ON nr.notification_id = n.id
  GROUP BY n.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_notification_delivery_summaries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_notification_delivery_summaries() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_notification_recipient_statuses(_notification_id uuid)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  email text,
  roles text[],
  read_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'superadmin'::public.app_role) THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  RETURN QUERY
  SELECT
    nr.user_id,
    nr.recipient_name,
    nr.recipient_email,
    nr.recipient_roles,
    nr.read_at
  FROM public.notification_recipients nr
  WHERE nr.notification_id = _notification_id
  ORDER BY nr.read_at NULLS LAST, nr.recipient_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_notification_recipient_statuses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_notification_recipient_statuses(uuid) TO authenticated;
