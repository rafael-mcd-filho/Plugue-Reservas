-- Reservation receipts belong to one platform account. This configuration is
-- separate from the read-only platform subscription billing integration.
CREATE TABLE public.platform_reservation_asaas_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  api_token_encrypted text,
  api_environment text NOT NULL DEFAULT 'production' CHECK (api_environment IN ('sandbox', 'production')),
  provider_account_id text,
  project_url text,
  token_last_four text,
  webhook_auth_token text NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  webhook_id text,
  webhook_email text,
  status text NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured', 'configured', 'error')),
  last_validated_at timestamptz,
  last_error text,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  provisioning_lease_id uuid,
  provisioning_lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT central_reservation_webhook_token_length CHECK (char_length(webhook_auth_token) BETWEEN 32 AND 255)
);

INSERT INTO public.platform_reservation_asaas_config (id) VALUES (true);
ALTER TABLE public.platform_reservation_asaas_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_reservation_asaas_config FROM anon, authenticated;
GRANT ALL ON TABLE public.platform_reservation_asaas_config TO service_role;

-- A rotated API key for the same account is safe. Replacing the account or
-- environment would make old charge IDs refer to the wrong provider account.
CREATE OR REPLACE FUNCTION public.guard_central_reservation_asaas_account()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.provider_account_id IS NOT NULL AND (
    NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
    OR NEW.api_environment IS DISTINCT FROM OLD.api_environment
  ) AND EXISTS (
    SELECT 1 FROM public.reservation_payments
    WHERE metadata ->> 'asaas_account_scope' = 'platform'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'A conta e o ambiente Asaas não podem mudar enquanto houver cobranças centrais no histórico';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_central_reservation_asaas_account
BEFORE UPDATE ON public.platform_reservation_asaas_config
FOR EACH ROW EXECUTE FUNCTION public.guard_central_reservation_asaas_account();

COMMENT ON TABLE public.platform_reservation_asaas_config IS
  'Service-role-only credentials for the single Asaas account receiving reservation prepayments. Never expose credentials to company staff.';

-- Company staff inspect their own rows through existing SELECT policies.
-- Financial mutations require the authenticated Edge handlers/service role.
DROP POLICY IF EXISTS "Company admins can update reservation payments" ON public.reservation_payments;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.reservation_payments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.reservation_payment_events FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.asaas_webhook_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_central_reservation_payment_account()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _config public.platform_reservation_asaas_config;
BEGIN
  IF NEW.metadata ->> 'asaas_account_scope' = 'platform' THEN
    SELECT * INTO _config FROM public.platform_reservation_asaas_config
    WHERE id = true FOR UPDATE;
    IF _config.provider_account_id IS NULL
      OR NEW.metadata ->> 'asaas_account_id' IS DISTINCT FROM _config.provider_account_id
      OR NEW.metadata ->> 'asaas_environment' IS DISTINCT FROM _config.api_environment THEN
      RAISE EXCEPTION 'A cobrança pertence a outra conta ou ambiente Asaas';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_central_reservation_payment_account
BEFORE INSERT ON public.reservation_payments
FOR EACH ROW EXECUTE FUNCTION public.guard_central_reservation_payment_account();

-- External webhook provisioning cannot share a PostgreSQL transaction. Use a
-- short lease so concurrent saves cannot create duplicate provider webhooks.
CREATE FUNCTION public.claim_central_reservation_asaas_config(_expected_revision uuid, _lease_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _expected_revision IS NULL OR _lease_id IS NULL THEN
    RAISE EXCEPTION 'Revisão e identificador da atualização são obrigatórios';
  END IF;
  UPDATE public.platform_reservation_asaas_config
  SET provisioning_lease_id = _lease_id, provisioning_lease_until = now() + interval '3 minutes'
  WHERE id = true AND revision = _expected_revision
    AND (provisioning_lease_id IS NULL OR provisioning_lease_until <= now());
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.release_central_reservation_asaas_config(_lease_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.platform_reservation_asaas_config
  SET provisioning_lease_id = NULL, provisioning_lease_until = NULL
  WHERE id = true AND provisioning_lease_id = _lease_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_central_reservation_asaas_config(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_central_reservation_asaas_config(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_central_reservation_asaas_config(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_central_reservation_asaas_config(uuid) TO service_role;
