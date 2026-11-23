-- Keep manual CRM corrections attached to the canonical lead that was edited,
-- even when its phone or email (and therefore its natural identity) changes.
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS profile_customer_key text;

CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_company_profile_customer_key_unique
  ON public.crm_leads(company_id, profile_customer_key)
  WHERE profile_customer_key IS NOT NULL AND profile_customer_key <> '';

DO $migration$
DECLARE
  _definition text;
  _updated_definition text;
BEGIN
  _definition := pg_get_functiondef('public._get_crm_lead_profiles(uuid)'::regprocedure);

  _updated_definition := replace(
    _definition,
    $old$      CASE
        WHEN normalized_imports.canonical_phone IS NOT NULL
          THEN 'phone:' || normalized_imports.canonical_phone
        WHEN normalized_imports.canonical_email IS NOT NULL
          THEN 'email:' || normalized_imports.canonical_email
        ELSE 'contact:crm_lead:' || normalized_imports.id::text
      END AS customer_key,$old$,
    $new$      CASE
        WHEN NULLIF(btrim(normalized_imports.profile_customer_key), '') IS NOT NULL
          THEN btrim(normalized_imports.profile_customer_key)
        WHEN normalized_imports.canonical_phone IS NOT NULL
          THEN 'phone:' || normalized_imports.canonical_phone
        WHEN normalized_imports.canonical_email IS NOT NULL
          THEN 'email:' || normalized_imports.canonical_email
        ELSE 'contact:crm_lead:' || normalized_imports.id::text
      END AS customer_key,$new$
  );

  IF _updated_definition = _definition THEN
    RAISE EXCEPTION 'Nao foi possivel tornar a identidade editada do lead estavel.';
  END IF;
  _definition := _updated_definition;

  _updated_definition := replace(
    _definition,
    $old$      COALESCE(visible_contact_rollup.phone_normalized, latest_imports.canonical_phone) AS phone_normalized,
      COALESCE(visible_contact_rollup.email_normalized, latest_imports.canonical_email) AS email_normalized,$old$,
    $new$      CASE
        WHEN latest_imports.source = 'manual_edit' THEN latest_imports.canonical_phone
        ELSE COALESCE(visible_contact_rollup.phone_normalized, latest_imports.canonical_phone)
      END AS phone_normalized,
      CASE
        WHEN latest_imports.source = 'manual_edit' THEN latest_imports.canonical_email
        ELSE COALESCE(visible_contact_rollup.email_normalized, latest_imports.canonical_email)
      END AS email_normalized,$new$
  );

  IF _updated_definition = _definition THEN
    RAISE EXCEPTION 'Nao foi possivel priorizar os contatos editados do lead.';
  END IF;
  _definition := _updated_definition;

  _updated_definition := replace(
    _definition,
    'WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN',
    'WHEN latest_imports.source = ''manual_edit'' OR latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN'
  );

  IF _updated_definition = _definition THEN
    RAISE EXCEPTION 'Nao foi possivel priorizar os dados editados do lead.';
  END IF;

  _definition := _updated_definition;
  _updated_definition := replace(
    _definition,
    $old$      CASE
        WHEN latest_imports.source = 'manual_edit' OR latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(
            NULLIF(btrim(latest_imports.phone), ''),
            latest_imports.canonical_phone,
            visible_contact_rollup.display_phone,
            ''
          )
        ELSE$old$,
    $new$      CASE
        WHEN latest_imports.source = 'manual_edit' THEN
          COALESCE(NULLIF(btrim(latest_imports.phone), ''), latest_imports.canonical_phone, '')
        WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(
            NULLIF(btrim(latest_imports.phone), ''),
            latest_imports.canonical_phone,
            visible_contact_rollup.display_phone,
            ''
          )
        ELSE$new$
  );

  IF _updated_definition = _definition THEN
    RAISE EXCEPTION 'Nao foi possivel permitir a remocao do telefone editado.';
  END IF;

  _definition := _updated_definition;
  _updated_definition := replace(
    _definition,
    $old$      CASE
        WHEN latest_imports.source = 'manual_edit' OR latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(
            NULLIF(lower(btrim(latest_imports.email)), ''),
            latest_imports.canonical_email,
            visible_contact_rollup.latest_email
          )
        ELSE$old$,
    $new$      CASE
        WHEN latest_imports.source = 'manual_edit' THEN latest_imports.canonical_email
        WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(
            NULLIF(lower(btrim(latest_imports.email)), ''),
            latest_imports.canonical_email,
            visible_contact_rollup.latest_email
          )
        ELSE$new$
  );

  IF _updated_definition = _definition THEN
    RAISE EXCEPTION 'Nao foi possivel permitir a remocao do email editado.';
  END IF;

  _definition := _updated_definition;
  _updated_definition := replace(
    _definition,
    $old$      CASE
        WHEN latest_imports.source = 'manual_edit' OR latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(latest_imports.birthdate, visible_contact_rollup.latest_birthdate)
        ELSE$old$,
    $new$      CASE
        WHEN latest_imports.source = 'manual_edit' THEN latest_imports.birthdate
        WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(latest_imports.birthdate, visible_contact_rollup.latest_birthdate)
        ELSE$new$
  );

  IF _updated_definition = _definition THEN
    RAISE EXCEPTION 'Nao foi possivel permitir a remocao do nascimento editado.';
  END IF;

  EXECUTE _updated_definition;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.upsert_crm_lead_profile(
  _company_id uuid,
  _customer_key text,
  _full_name text,
  _phone text DEFAULT NULL,
  _email text DEFAULT NULL,
  _birthdate date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _effective_customer_key text := btrim(COALESCE(_customer_key, ''));
  _effective_full_name text := btrim(COALESCE(_full_name, ''));
  _effective_phone text := NULLIF(btrim(COALESCE(_phone, '')), '');
  _effective_email text := NULLIF(lower(btrim(COALESCE(_email, ''))), '');
  _phone_normalized text;
  _existing_crm_lead_id uuid;
  _saved_id uuid;
BEGIN
  -- Authorize before validating caller-controlled profile data.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;

    IF public.has_company_panel_permission(auth.uid(), _company_id, 'leads_view') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Sem permissao para editar leads.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id e obrigatorio.' USING ERRCODE = '22023';
  END IF;

  IF _effective_customer_key = '' OR char_length(_effective_customer_key) > 500 THEN
    RAISE EXCEPTION 'customer_key invalida.' USING ERRCODE = '22023';
  END IF;

  SELECT profiles.crm_lead_id
  INTO _existing_crm_lead_id
  FROM public._get_crm_lead_profiles(_company_id) AS profiles
  WHERE profiles.customer_key = _effective_customer_key
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead nao encontrado.' USING ERRCODE = 'P0002';
  END IF;

  IF _effective_full_name = '' OR char_length(_effective_full_name) > 160 THEN
    RAISE EXCEPTION 'Nome do lead invalido.' USING ERRCODE = '22023';
  END IF;

  IF _effective_phone IS NOT NULL THEN
    _phone_normalized := public.normalize_whatsapp_phone(_effective_phone);

    IF _phone_normalized !~ '^55[1-9][0-9](9?[0-9]{8})$' THEN
      RAISE EXCEPTION 'Telefone do lead invalido.' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF _effective_email IS NOT NULL AND (
    char_length(_effective_email) > 320
    OR _effective_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) THEN
    RAISE EXCEPTION 'Email do lead invalido.' USING ERRCODE = '22023';
  END IF;

  IF _phone_normalized IS NULL AND _effective_email IS NULL THEN
    RAISE EXCEPTION 'Informe um telefone ou email.' USING ERRCODE = '22023';
  END IF;

  IF _birthdate IS NOT NULL AND _birthdate > current_date THEN
    RAISE EXCEPTION 'Data de nascimento invalida.' USING ERRCODE = '22023';
  END IF;

  IF _existing_crm_lead_id IS NOT NULL THEN
    UPDATE public.crm_leads
    SET
      profile_customer_key = _effective_customer_key,
      full_name = _effective_full_name,
      phone = _effective_phone,
      phone_normalized = _phone_normalized,
      email = _effective_email,
      email_normalized = _effective_email,
      birthdate = _birthdate,
      source = 'manual_edit'
    WHERE id = _existing_crm_lead_id
      AND company_id = _company_id
    RETURNING id INTO _saved_id;
  ELSE
    INSERT INTO public.crm_leads (
      company_id,
      profile_customer_key,
      full_name,
      phone,
      phone_normalized,
      email,
      email_normalized,
      birthdate,
      source,
      imported_by_user_id
    )
    VALUES (
      _company_id,
      _effective_customer_key,
      _effective_full_name,
      _effective_phone,
      _phone_normalized,
      _effective_email,
      _effective_email,
      _birthdate,
      'manual_edit',
      auth.uid()
    )
    RETURNING id INTO _saved_id;
  END IF;

  RETURN jsonb_build_object('id', _saved_id, 'customer_key', _effective_customer_key);
END;
$$;

COMMENT ON FUNCTION public.upsert_crm_lead_profile(uuid, text, text, text, text, date)
IS 'Cria ou atualiza os dados editaveis do perfil CRM sem alterar o historico operacional de reservas e fila.';

REVOKE ALL ON FUNCTION public.upsert_crm_lead_profile(uuid, text, text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_crm_lead_profile(uuid, text, text, text, text, date)
  TO authenticated, service_role;

