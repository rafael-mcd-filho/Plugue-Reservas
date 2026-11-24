-- Optional pricing by environment. Existing rules and reservations keep their
-- single-price behavior; no company or day is opted in by this migration.
-- Availability owns the environment choice, including free bookings and
-- capacity-only slots. Payment rules only supply commercial values.
ALTER TABLE public.reservation_schedule_rule_slots
  ADD COLUMN IF NOT EXISTS allow_section_selection boolean NOT NULL DEFAULT false;
CREATE TABLE public.reservation_schedule_rule_slot_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  slot_id uuid NOT NULL REFERENCES public.reservation_schedule_rule_slots(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.table_sections(id) ON DELETE NO ACTION,
  capacity_guests integer CHECK (capacity_guests IS NULL OR capacity_guests BETWEEN 1 AND 10000),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  UNIQUE(slot_id,section_id)
);
CREATE INDEX idx_reservation_schedule_slot_sections_company
  ON public.reservation_schedule_rule_slot_sections(company_id,slot_id);
ALTER TABLE public.reservation_schedule_rule_slot_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Company staff can view schedule slot sections"
ON public.reservation_schedule_rule_slot_sections FOR SELECT TO authenticated USING (
  public.has_role(auth.uid(),'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(),'admin'::public.app_role,company_id)
  OR public.has_role_in_company(auth.uid(),'operator'::public.app_role,company_id)
);
CREATE POLICY "Company admins can manage schedule slot sections"
ON public.reservation_schedule_rule_slot_sections FOR ALL TO authenticated USING (
  public.has_role(auth.uid(),'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(),'admin'::public.app_role,company_id)
) WITH CHECK (
  public.has_role(auth.uid(),'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(),'admin'::public.app_role,company_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.reservation_schedule_rule_slot_sections TO authenticated;
GRANT ALL ON public.reservation_schedule_rule_slot_sections TO service_role;

CREATE FUNCTION public.validate_reservation_schedule_slot_section()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _company_id uuid; _mode text; _limit integer; _allocated integer;
BEGIN
  SELECT r.company_id, COALESCE(b.availability_mode,r.availability_mode,'tables'),s.max_guests_per_slot
  INTO _company_id,_mode,_limit FROM public.reservation_schedule_rule_slots s
  JOIN public.reservation_schedule_rules r ON r.id=s.rule_id
  LEFT JOIN public.reservation_schedule_rule_blocks b ON b.id=s.block_id
  WHERE s.id=NEW.slot_id FOR UPDATE OF s;
  IF NOT FOUND OR NEW.company_id<>_company_id OR NOT EXISTS (
    SELECT 1 FROM public.table_sections ts WHERE ts.id=NEW.section_id AND ts.company_id=_company_id
  ) THEN RAISE EXCEPTION 'Ambiente e horario devem pertencer a mesma empresa.'; END IF;
  IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.slot_id IS DISTINCT FROM OLD.slot_id
    OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    RAISE EXCEPTION 'O vinculo do ambiente com o horario nao pode ser alterado.';
  END IF;
  IF _mode='capacity' AND NEW.enabled THEN
    IF COALESCE(NEW.capacity_guests,0)<=0 THEN RAISE EXCEPTION 'Informe a capacidade de cada ambiente neste horario.'; END IF;
    SELECT COALESCE(sum(x.capacity_guests),0)::integer INTO _allocated
    FROM public.reservation_schedule_rule_slot_sections x WHERE x.slot_id=NEW.slot_id AND x.enabled AND x.id<>NEW.id;
    IF _allocated+NEW.capacity_guests>COALESCE(_limit,0) THEN
      RAISE EXCEPTION 'A soma das capacidades dos ambientes supera o limite de pessoas do horario.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_reservation_schedule_slot_section
BEFORE INSERT OR UPDATE ON public.reservation_schedule_rule_slot_sections
FOR EACH ROW EXECUTE FUNCTION public.validate_reservation_schedule_slot_section();

CREATE FUNCTION public.configure_reservation_schedule_slot_sections(
  _slot_id uuid,_company_id uuid,_allow boolean,_sections jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _item jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(_sections,'[]'::jsonb))<>'array' THEN RAISE EXCEPTION 'Lista de ambientes invalida.'; END IF;
  UPDATE public.reservation_schedule_rule_slots SET allow_section_selection=COALESCE(_allow,false) WHERE id=_slot_id;
  FOR _item IN SELECT value FROM jsonb_array_elements(COALESCE(_sections,'[]'::jsonb)) LOOP
    INSERT INTO public.reservation_schedule_rule_slot_sections(company_id,slot_id,section_id,capacity_guests,enabled,sort_order)
    VALUES(_company_id,_slot_id,(_item->>'section_id')::uuid,NULLIF(_item->>'capacity_guests','')::integer,
      COALESCE((_item->>'enabled')::boolean,true),COALESCE((_item->>'sort_order')::integer,100));
  END LOOP;
  IF _allow AND NOT EXISTS (SELECT 1 FROM public.reservation_schedule_rule_slot_sections WHERE slot_id=_slot_id AND enabled) THEN
    RAISE EXCEPTION 'Selecione pelo menos um ambiente para o horario.';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.configure_reservation_schedule_slot_sections(uuid,uuid,boolean,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.validate_reservation_schedule_slot_section() FROM PUBLIC,anon,authenticated,service_role;

DO $patch_schedule_sections$
DECLARE _definition text; _anchor text;
BEGIN
  _definition:=replace(pg_get_functiondef('public.upsert_reservation_schedule_rule(uuid,text,text,uuid,date,date,boolean,integer,timestamptz,jsonb)'::regprocedure),E'\r\n',E'\n');
  IF position('reservation_schedule_section_configuration' IN _definition)=0 THEN
    _anchor:=E'  _saved_id uuid;';
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing schedule section declaration anchor.'; END IF;
    _definition:=replace(_definition,_anchor,_anchor||E'\n  _section_slot_id uuid;');
    _anchor:=E'        COALESCE((_slot_item ->> ''is_full'')::boolean, false)\n      );';
    IF position(_anchor IN _definition)=0 THEN
      _anchor:=E'        NULLIF(_slot_item ->> ''max_guests_per_slot'', '''')::integer\n      );';
    END IF;
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing schedule section insert anchor.'; END IF;
    _definition:=replace(_definition,_anchor,replace(_anchor,E'\n      );',E'\n      ) RETURNING id INTO _section_slot_id;')||E'\n      -- reservation_schedule_section_configuration: slot owns environments.\n      PERFORM public.configure_reservation_schedule_slot_sections(\n        _section_slot_id,_company_id,COALESCE((_slot_item->>''allow_section_selection'')::boolean,false),\n        COALESCE(_slot_item->''sections'',''[]''::jsonb));');
    EXECUTE _definition;
  END IF;
END;
$patch_schedule_sections$;

ALTER TABLE public.reservation_payment_rules
  ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'single';
ALTER TABLE public.reservation_payment_rules
  ADD CONSTRAINT reservation_payment_rules_pricing_mode_check
  CHECK (pricing_mode IN ('single', 'by_section'));

CREATE TABLE public.reservation_payment_rule_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES public.reservation_payment_rules(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.table_sections(id) ON DELETE NO ACTION,
  public_name text NOT NULL,
  description text,
  base_amount numeric(10,2) NOT NULL CHECK (base_amount > 0),
  pix_amount numeric(10,2) CHECK (pix_amount IS NULL OR pix_amount > 0),
  credit_card_amount numeric(10,2) CHECK (credit_card_amount IS NULL OR credit_card_amount > 0),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_payment_rule_sections_public_name_check CHECK (length(btrim(public_name)) > 0),
  CONSTRAINT reservation_payment_rule_sections_unique_section UNIQUE (rule_id, section_id)
);
CREATE INDEX idx_reservation_payment_rule_sections_company
  ON public.reservation_payment_rule_sections(company_id, rule_id, sort_order);
ALTER TABLE public.reservation_payment_rule_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Company staff can view reservation payment rule sections"
ON public.reservation_payment_rule_sections FOR SELECT TO authenticated USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);
CREATE POLICY "Company admins can manage reservation payment rule sections"
ON public.reservation_payment_rule_sections FOR ALL TO authenticated USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
) WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservation_payment_rule_sections TO authenticated;
GRANT ALL ON public.reservation_payment_rule_sections TO service_role;

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS selected_section_id uuid REFERENCES public.table_sections(id) ON DELETE NO ACTION,
  ADD COLUMN IF NOT EXISTS selected_section_name text;
CREATE INDEX idx_reservations_selected_section
  ON public.reservations(company_id, selected_section_id, date) WHERE selected_section_id IS NOT NULL;

-- Parent and children share a row lock. A concurrent option edit cannot race
-- activation or a payment that is being created under a frozen configuration.
CREATE FUNCTION public.validate_reservation_rule_section_pricing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _day date; _schedule record; _slot_time time; _slot public.reservation_schedule_rule_slots;
  _map_id uuid; _eligible integer; _missing text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('reservation-payment-rules|' || NEW.company_id::text, 0));
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'A empresa e a identificacao da regra nao podem ser alteradas.';
    END IF;
    IF NEW.pricing_mode IS DISTINCT FROM OLD.pricing_mode
      AND EXISTS (SELECT 1 FROM public.reservation_payments p WHERE p.rule_id = OLD.id) THEN
      RAISE EXCEPTION 'Regra ja usada nao pode ser editada; desative ou arquive e crie uma nova regra';
    END IF;
  END IF;
  IF NEW.pricing_mode = 'single'
    AND EXISTS (SELECT 1 FROM public.reservation_payment_rule_sections s WHERE s.rule_id = NEW.id) THEN
    RAISE EXCEPTION 'Remova as opcoes de ambiente antes de alterar o modo de preco.';
  END IF;
  IF NEW.pricing_mode = 'by_section' AND NEW.enabled AND NEW.archived_at IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.reservation_payment_rule_sections s WHERE s.rule_id = NEW.id AND s.enabled) THEN
      RAISE EXCEPTION 'Cadastre pelo menos um ambiente habilitado antes de ativar a regra.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.reservation_payment_rule_sections s
      LEFT JOIN public.table_sections ts ON ts.id = s.section_id AND ts.company_id = NEW.company_id
      WHERE s.rule_id = NEW.id AND s.enabled AND (
        ts.id IS NULL OR s.company_id <> NEW.company_id OR s.base_amount <= 0
        OR (NEW.pix_enabled AND COALESCE(s.pix_amount, 0) <= 0)
        OR (NEW.credit_card_enabled AND COALESCE(s.credit_card_amount, 0) <= 0)
      )
    ) THEN
      RAISE EXCEPTION 'Configure os valores de todos os meios de pagamento nos ambientes habilitados.';
    END IF;
    IF NEW.date_end-NEW.date_start>730 THEN
      RAISE EXCEPTION 'Regras por ambiente devem abranger um periodo de ate 731 dias.';
    END IF;
    -- Validate the effective calendar, including weekly rules, special dates,
    -- blocked windows and special maps, rather than every configured draft.
    FOR _day IN SELECT value::date FROM generate_series(NEW.date_start::timestamp,NEW.date_end::timestamp,interval '1 day') value LOOP
      SELECT * INTO _schedule FROM public.get_public_reservation_schedule(NEW.company_id,_day) LIMIT 1;
      IF NOT FOUND OR _schedule.source='blocked' THEN CONTINUE; END IF;
      FOR _slot_time IN SELECT value::time FROM jsonb_array_elements_text(COALESCE(_schedule.slots,'[]'::jsonb)) value LOOP
        IF EXISTS(SELECT 1 FROM public.blocked_dates bd WHERE bd.company_id=NEW.company_id AND bd.date=_day
          AND (bd.all_day OR (NOT bd.all_day AND _slot_time>=COALESCE(bd.start_time,'00:00'::time)
            AND _slot_time<COALESCE(bd.end_time,'23:59:59'::time)))) THEN CONTINUE; END IF;
        _slot:=public.resolve_public_reservation_section_slot(NEW.company_id,_day,_slot_time);
        IF COALESCE(_slot.is_full,false) THEN CONTINUE; END IF;
        IF NOT COALESCE(_slot.allow_section_selection,false) THEN
          RAISE EXCEPTION 'Ative a escolha de ambiente na disponibilidade de % as % antes de ativar esta regra.',to_char(_day,'DD/MM/YYYY'),to_char(_slot_time,'HH24:MI');
        END IF;
        SELECT id INTO _map_id FROM public.get_active_table_map(NEW.company_id,(_day+_slot_time)::timestamptz) LIMIT 1;
        SELECT count(*)::integer,min(ts.name) FILTER(WHERE price.id IS NULL)
        INTO _eligible,_missing
        FROM public.reservation_schedule_rule_slot_sections ss
        JOIN public.table_sections ts ON ts.id=ss.section_id AND ts.company_id=NEW.company_id
        LEFT JOIN public.reservation_payment_rule_sections price ON price.rule_id=NEW.id AND price.section_id=ts.id AND price.enabled
        WHERE ss.slot_id=_slot.id AND ss.enabled AND (
          (_schedule.availability_mode='capacity' AND ss.capacity_guests>0)
          OR (_schedule.availability_mode='tables' AND EXISTS(SELECT 1 FROM public.restaurant_tables t
            WHERE t.company_id=NEW.company_id AND t.table_map_id=_map_id AND t.section=ts.code AND t.status='available'))
        );
        IF _eligible=0 THEN
          RAISE EXCEPTION 'A disponibilidade de % as % nao possui ambientes validos para esta regra.',to_char(_day,'DD/MM/YYYY'),to_char(_slot_time,'HH24:MI');
        END IF;
        IF _missing IS NOT NULL THEN
          RAISE EXCEPTION 'Configure o valor do ambiente % disponivel em % as % antes de ativar esta regra.',_missing,to_char(_day,'DD/MM/YYYY'),to_char(_slot_time,'HH24:MI');
        END IF;
      END LOOP;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER aab_reservation_rule_section_pricing
BEFORE INSERT OR UPDATE ON public.reservation_payment_rules
FOR EACH ROW EXECUTE FUNCTION public.validate_reservation_rule_section_pricing();

CREATE FUNCTION public.validate_reservation_payment_rule_section()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _rule public.reservation_payment_rules; _rule_id uuid;
BEGIN
  _rule_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.rule_id ELSE NEW.rule_id END;
  SELECT * INTO _rule FROM public.reservation_payment_rules WHERE id = _rule_id FOR UPDATE;
  -- Preserve company/rule cascade deletion. Normal used rules remain archive-only.
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = _rule.company_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Regra de pagamento nao encontrada.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_payments p WHERE p.rule_id = _rule.id) THEN
    RAISE EXCEPTION 'Regra ja usada nao pode ser editada; desative ou arquive e crie uma nova regra';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
      OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
      RAISE EXCEPTION 'O vinculo da opcao de ambiente nao pode ser alterado.';
    END IF;
    IF _rule.pricing_mode <> 'by_section' OR NEW.company_id <> _rule.company_id
      OR NOT EXISTS (SELECT 1 FROM public.table_sections s WHERE s.id = NEW.section_id AND s.company_id = _rule.company_id) THEN
      RAISE EXCEPTION 'Ambiente e regra devem pertencer a mesma empresa e usar preco por ambiente.';
    END IF;
    IF NEW.enabled AND ((_rule.pix_enabled AND COALESCE(NEW.pix_amount, 0) <= 0)
      OR (_rule.credit_card_enabled AND COALESCE(NEW.credit_card_amount, 0) <= 0)) THEN
      RAISE EXCEPTION 'Configure os valores de todos os meios de pagamento no ambiente.';
    END IF;
    NEW.public_name := btrim(NEW.public_name);
    NEW.updated_at := now();
  END IF;
  IF _rule.enabled AND _rule.archived_at IS NULL AND OLD.enabled
    AND (TG_OP = 'DELETE' OR NOT NEW.enabled)
    AND NOT EXISTS (SELECT 1 FROM public.reservation_payment_rule_sections s
      WHERE s.rule_id = _rule.id AND s.id <> OLD.id AND s.enabled) THEN
    RAISE EXCEPTION 'A regra ativa deve manter pelo menos um ambiente habilitado.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_reservation_payment_rule_section
BEFORE INSERT OR UPDATE OR DELETE ON public.reservation_payment_rule_sections
FOR EACH ROW EXECUTE FUNCTION public.validate_reservation_payment_rule_section();

-- Create as a draft, insert every child, then activate in the same transaction.
-- SECURITY DEFINER uses exactly the same admin/delegated-role helpers as RLS.
CREATE FUNCTION public.create_reservation_payment_rule(_rule jsonb, _sections jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _created public.reservation_payment_rules; _company_id uuid; _item jsonb; _enabled boolean;
BEGIN
  IF jsonb_typeof(_rule) IS DISTINCT FROM 'object' OR jsonb_typeof(_sections) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Dados da regra de pagamento invalidos.';
  END IF;
  _company_id := NULLIF(_rule->>'company_id', '')::uuid;
  IF _company_id IS NULL OR NOT COALESCE((
    auth.role() = 'service_role'
    OR public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
  ),false) THEN RAISE EXCEPTION 'Sem permissao para criar regras de pagamento.' USING ERRCODE = '42501'; END IF;
  _enabled := COALESCE((_rule->>'enabled')::boolean, false);
  IF COALESCE(_rule->>'pricing_mode', 'single') = 'single' AND jsonb_array_length(_sections) <> 0 THEN
    RAISE EXCEPTION 'A regra de valor unico nao aceita opcoes de ambiente.';
  END IF;
  INSERT INTO public.reservation_payment_rules (
    company_id, name, enabled, date_start, date_end, amount_type, base_amount,
    pix_enabled, pix_amount, credit_card_enabled, credit_card_amount, max_credit_card_installments,
    payment_deadline_minutes, customer_notice, cancellation_policy, created_by, pricing_mode
  ) VALUES (
    _company_id, btrim(_rule->>'name'), false, (_rule->>'date_start')::date, (_rule->>'date_end')::date,
    _rule->>'amount_type', (_rule->>'base_amount')::numeric,
    COALESCE((_rule->>'pix_enabled')::boolean, true), (_rule->>'pix_amount')::numeric,
    COALESCE((_rule->>'credit_card_enabled')::boolean, false), (_rule->>'credit_card_amount')::numeric,
    CASE WHEN COALESCE((_rule->>'credit_card_enabled')::boolean, false) THEN 1 ELSE NULL END,
    COALESCE((_rule->>'payment_deadline_minutes')::integer, 10),
    NULLIF(btrim(_rule->>'customer_notice'), ''), NULLIF(btrim(_rule->>'cancellation_policy'), ''),
    auth.uid(), COALESCE(_rule->>'pricing_mode', 'single')
  ) RETURNING * INTO _created;
  FOR _item IN SELECT value FROM jsonb_array_elements(_sections) LOOP
    INSERT INTO public.reservation_payment_rule_sections (
      company_id, rule_id, section_id, public_name, description, base_amount, pix_amount,
      credit_card_amount, enabled, sort_order
    ) VALUES (
      _company_id, _created.id, (_item->>'section_id')::uuid,
      COALESCE(NULLIF(btrim(_item->>'public_name'), ''),
        (SELECT name FROM public.table_sections WHERE id = (_item->>'section_id')::uuid AND company_id = _company_id)),
      NULLIF(btrim(_item->>'description'), ''), (_item->>'base_amount')::numeric,
      (_item->>'pix_amount')::numeric, (_item->>'credit_card_amount')::numeric,
      COALESCE((_item->>'enabled')::boolean, true), COALESCE((_item->>'sort_order')::integer, 100)
    );
  END LOOP;
  IF _enabled THEN
    UPDATE public.reservation_payment_rules SET enabled = true, activated_at = now() WHERE id = _created.id
    RETURNING * INTO _created;
  END IF;
  RETURN to_jsonb(_created) || jsonb_build_object('sections', (
    SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.sort_order, s.created_at, s.id), '[]'::jsonb)
    FROM public.reservation_payment_rule_sections s WHERE s.rule_id = _created.id
  ));
END;
$$;
REVOKE ALL ON FUNCTION public.create_reservation_payment_rule(jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_reservation_payment_rule(jsonb,jsonb) TO authenticated, service_role;

CREATE FUNCTION public.pick_best_fit_reservation_section_table(
  _company_id uuid, _date date, _time time, _duration_minutes integer, _party_size integer,
  _active_table_map_id uuid, _section_id uuid, _exclude_reservation_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id FROM public.restaurant_tables t
  JOIN public.table_sections s ON s.company_id = t.company_id AND s.code = t.section
  WHERE t.company_id = _company_id AND s.id = _section_id AND t.status = 'available'
    AND t.table_map_id = _active_table_map_id AND t.capacity >= _party_size
    AND public.reservation_table_conflict_id(_company_id, _date, _time, _duration_minutes, t.id, _exclude_reservation_id) IS NULL
  ORDER BY t.capacity, t.number, t.id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.pick_best_fit_reservation_section_table(uuid,date,time,integer,integer,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pick_best_fit_reservation_section_table(uuid,date,time,integer,integer,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.resolve_public_reservation_section_slot(_company_id uuid,_date date,_time time)
RETURNS public.reservation_schedule_rule_slots LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.* FROM public.get_public_reservation_schedule(_company_id,_date) resolved
  JOIN public.reservation_schedule_rule_slots s ON s.time=_time AND (
    s.block_id=resolved.block_id OR (s.block_id IS NULL AND s.rule_id=resolved.rule_id)
  ) WHERE resolved.source<>'blocked'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(resolved.slots,'[]'::jsonb)) value WHERE value=to_char(_time,'HH24:MI'))
  ORDER BY CASE WHEN s.block_id=resolved.block_id THEN 0 ELSE 1 END,s.sort_order,s.created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.resolve_public_reservation_section_slot(uuid,date,time) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.count_overlapping_reservation_section_guests(
  _company_id uuid,_date date,_time time,_duration_minutes integer,_section_id uuid,_exclude_reservation_id uuid DEFAULT NULL
) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE(sum(r.party_size),0)::integer FROM public.reservations r
  WHERE r.company_id=_company_id AND r.date=_date AND (
    r.selected_section_id=_section_id OR (r.selected_section_id IS NULL AND (
      COALESCE(r.created_in_mode,'tables')='capacity'
      OR EXISTS(SELECT 1 FROM public.reservation_table_assignments a
        JOIN public.restaurant_tables t ON t.id=a.table_id
        JOIN public.table_sections ts ON ts.company_id=t.company_id AND ts.code=t.section
        WHERE a.reservation_id=r.id AND ts.id=_section_id)
      OR EXISTS(SELECT 1 FROM public.restaurant_tables t
        JOIN public.table_sections ts ON ts.company_id=t.company_id AND ts.code=t.section
        WHERE t.id=r.table_id AND ts.id=_section_id)
      OR (r.table_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.reservation_table_assignments a WHERE a.reservation_id=r.id))
    ))
  )
    AND (_exclude_reservation_id IS NULL OR r.id<>_exclude_reservation_id)
    AND public.is_reservation_occupying_capacity(r.id,r.status,r.created_at)
    AND r.date+r.time<_date+_time+make_interval(mins=>GREATEST(_duration_minutes,1))
    AND r.date+r.time+make_interval(mins=>GREATEST(COALESCE(r.duration_minutes,30),1))>_date+_time;
$$;
REVOKE ALL ON FUNCTION public.count_overlapping_reservation_section_guests(uuid,date,time,integer,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.reservation_section_capacity_enabled(_company_id uuid,_date date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.get_public_reservation_schedule(_company_id,_date) resolved
    JOIN public.reservation_schedule_rule_slots s ON s.allow_section_selection AND (
      s.block_id=resolved.block_id OR (s.block_id IS NULL AND s.rule_id=resolved.rule_id)
    ) WHERE resolved.source<>'blocked' AND EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(resolved.slots,'[]'::jsonb)) value WHERE value=to_char(s.time,'HH24:MI')));
$$;
REVOKE ALL ON FUNCTION public.reservation_section_capacity_enabled(uuid,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.reservation_section_capacity_available(
  _company_id uuid,_date date,_time time,_duration_minutes integer,_party_size integer,
  _section_id uuid,_exclude_reservation_id uuid DEFAULT NULL
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH windows AS (
    SELECT ss.section_id,ss.capacity_guests,
      GREATEST(_date+_time,_date+s.time) AS overlap_start,
      LEAST(_date+_time+make_interval(mins=>GREATEST(_duration_minutes,1)),
        _date+s.time+make_interval(mins=>GREATEST(COALESCE(s.duration_minutes,resolved.default_duration_minutes,c.reservation_duration,30),1))) AS overlap_end
    FROM public.get_public_reservation_schedule(_company_id,_date) resolved
    JOIN public.companies c ON c.id=_company_id
    JOIN public.reservation_schedule_rule_slots s ON s.allow_section_selection AND (
      s.block_id=resolved.block_id OR (s.block_id IS NULL AND s.rule_id=resolved.rule_id)
    )
    JOIN public.reservation_schedule_rule_slot_sections ss ON ss.slot_id=s.id AND ss.enabled AND ss.capacity_guests IS NOT NULL
    WHERE resolved.source<>'blocked' AND (_section_id IS NULL OR ss.section_id=_section_id)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(resolved.slots,'[]'::jsonb)) value WHERE value=to_char(s.time,'HH24:MI'))
  ) SELECT NOT EXISTS(SELECT 1 FROM windows w WHERE w.overlap_start<w.overlap_end AND w.capacity_guests<_party_size
    +public.count_overlapping_reservation_section_guests(_company_id,_date,w.overlap_start::time,
      GREATEST(ceil(extract(epoch FROM w.overlap_end-w.overlap_start)/60)::integer,1),w.section_id,_exclude_reservation_id));
$$;
REVOKE ALL ON FUNCTION public.reservation_section_capacity_available(uuid,date,time,integer,integer,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.enforce_reservation_section_capacity(
  _company_id uuid,_date date,_time time,_duration_minutes integer,_party_size integer,
  _section_id uuid,_exclude_reservation_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- Check every affected service window, including when this arrival's own
  -- slot has selection disabled but overlaps another slot with environment caps.
  IF NOT public.reservation_section_capacity_enabled(_company_id,_date) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-capacity|%s|%s',_company_id::text,_date::text),0));
  IF NOT public.reservation_section_capacity_available(_company_id,_date,_time,_duration_minutes,_party_size,_section_id,_exclude_reservation_id) THEN
    RAISE EXCEPTION 'Capacidade do ambiente atingida para este horario.';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_reservation_section_capacity(uuid,date,time,integer,integer,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.list_reservation_pricing_sections(_company_id uuid,_date_start date,_date_end date)
RETURNS TABLE(id uuid,name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(),'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(),'admin'::public.app_role,_company_id)
    OR public.has_role_in_company(auth.uid(),'operator'::public.app_role,_company_id)) THEN
    RAISE EXCEPTION 'Sem permissao para consultar os ambientes da agenda.' USING ERRCODE='42501';
  END IF;
  IF _date_start IS NULL OR _date_end IS NULL OR _date_end<_date_start OR _date_end-_date_start>730 THEN
    RAISE EXCEPTION 'Informe um periodo de ate 731 dias.';
  END IF;
  RETURN QUERY SELECT DISTINCT ts.id,ts.name
  FROM generate_series(_date_start::timestamp,_date_end::timestamp,interval '1 day') day
  CROSS JOIN LATERAL public.get_public_reservation_schedule(_company_id,day::date) resolved
  JOIN public.reservation_schedule_rule_slots s ON (
    s.block_id=resolved.block_id OR (s.block_id IS NULL AND s.rule_id=resolved.rule_id)
  ) AND s.allow_section_selection
  JOIN public.reservation_schedule_rule_slot_sections ss ON ss.slot_id=s.id AND ss.enabled
  JOIN public.table_sections ts ON ts.id=ss.section_id AND ts.company_id=_company_id
  LEFT JOIN LATERAL public.get_active_table_map(_company_id,(day::date+s.time)::timestamptz) active_map ON true
  WHERE resolved.source<>'blocked'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(resolved.slots,'[]'::jsonb)) value WHERE value=to_char(s.time,'HH24:MI'))
    AND NOT EXISTS(SELECT 1 FROM public.blocked_dates bd WHERE bd.company_id=_company_id AND bd.date=day::date AND
      (bd.all_day OR (NOT bd.all_day AND s.time>=COALESCE(bd.start_time,'00:00'::time) AND s.time<COALESCE(bd.end_time,'23:59:59'::time))))
    AND ((resolved.availability_mode='capacity' AND ss.capacity_guests>0) OR (resolved.availability_mode='tables' AND EXISTS(
      SELECT 1 FROM public.restaurant_tables t WHERE t.company_id=_company_id AND t.table_map_id=active_map.id AND t.section=ts.code AND t.status='available'
    ))) ORDER BY ts.name,ts.id;
END;
$$;
REVOKE ALL ON FUNCTION public.list_reservation_pricing_sections(uuid,date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.list_reservation_pricing_sections(uuid,date,date) TO authenticated;

CREATE FUNCTION public.pick_automatic_reservation_section(
  _company_id uuid,_date date,_time time,_party_size integer,_duration_minutes integer,_availability_mode text
) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _slot public.reservation_schedule_rule_slots; _section_id uuid; _map_id uuid;
BEGIN
  _slot:=public.resolve_public_reservation_section_slot(_company_id,_date,_time);
  IF NOT COALESCE(_slot.allow_section_selection,false) THEN RETURN NULL; END IF;
  IF _availability_mode='capacity' THEN
    SELECT ss.section_id INTO _section_id FROM public.reservation_schedule_rule_slot_sections ss
    WHERE ss.slot_id=_slot.id AND ss.company_id=_company_id AND ss.enabled
      AND COALESCE(ss.capacity_guests,0)>=_party_size+public.count_overlapping_reservation_section_guests(
        _company_id,_date,_time,_duration_minutes,ss.section_id,NULL)
      AND public.reservation_section_capacity_available(_company_id,_date,_time,_duration_minutes,_party_size,ss.section_id,NULL)
    ORDER BY ss.sort_order,ss.id LIMIT 1;
  ELSE
    SELECT id INTO _map_id FROM public.get_active_table_map(_company_id,(_date+_time)::timestamptz) LIMIT 1;
    SELECT ss.section_id INTO _section_id FROM public.reservation_schedule_rule_slot_sections ss
    JOIN public.table_sections ts ON ts.id=ss.section_id AND ts.company_id=_company_id
    JOIN public.restaurant_tables t ON t.company_id=_company_id AND t.section=ts.code AND t.table_map_id=_map_id
    WHERE ss.slot_id=_slot.id AND ss.company_id=_company_id AND ss.enabled
      AND t.status='available' AND t.capacity>=_party_size
      AND public.reservation_table_conflict_id(_company_id,_date,_time,_duration_minutes,t.id,NULL) IS NULL
      AND public.reservation_section_capacity_available(_company_id,_date,_time,_duration_minutes,_party_size,ss.section_id,NULL)
    ORDER BY t.capacity,ss.sort_order,t.number,t.id LIMIT 1;
  END IF;
  RETURN _section_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pick_automatic_reservation_section(uuid,date,time,integer,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.get_public_reservation_section_options(_company_id uuid, _date date, _time time, _party_size integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _rule public.reservation_payment_rules; _availability record; _map_id uuid; _options jsonb;
  _slot public.reservation_schedule_rule_slots;
BEGIN
  IF _company_id IS NULL OR _date IS NULL OR _time IS NULL OR _party_size IS NULL OR _party_size NOT BETWEEN 1 AND 20
    OR NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = _company_id AND c.status = 'active') THEN
    RETURN jsonb_build_object('enabled', false, 'rule_id', NULL, 'options', '[]'::jsonb);
  END IF;
  IF public.company_feature_enabled(_company_id,'reservation_prepayment') THEN
    SELECT * INTO _rule FROM public.reservation_payment_rules
    WHERE company_id = _company_id AND enabled AND archived_at IS NULL AND _date BETWEEN date_start AND date_end
    ORDER BY created_at DESC, id LIMIT 1;
  END IF;
  _slot:=public.resolve_public_reservation_section_slot(_company_id,_date,_time);
  IF NOT COALESCE(_slot.allow_section_selection,false) THEN
    RETURN jsonb_build_object('enabled', false, 'rule_id', _rule.id, 'options', '[]'::jsonb,
      'configuration_error',CASE WHEN _rule.pricing_mode='by_section' THEN 'A regra de pagamento por ambiente exige escolha de ambiente neste horario.' ELSE NULL END);
  END IF;
  -- A single paid price has no public environment choice. Availability still
  -- owns the permitted environments and quotas used by server auto-allocation.
  IF _rule.pricing_mode='single' THEN
    SELECT * INTO _availability FROM public.get_public_reservation_availability(_company_id,_date,_party_size)
    WHERE time_slot=_time LIMIT 1;
    RETURN jsonb_build_object('enabled',false,'rule_id',_rule.id,'options','[]'::jsonb,
      'automatic_allocation_available',COALESCE(_availability.available,false)
        AND public.pick_automatic_reservation_section(_company_id,_date,_time,_party_size,
          COALESCE(_availability.duration_minutes,30),COALESCE(_availability.availability_mode,'tables')) IS NOT NULL);
  END IF;
  SELECT * INTO _availability FROM public.get_public_reservation_availability(_company_id, _date, _party_size)
  WHERE time_slot = _time LIMIT 1;
  SELECT id INTO _map_id FROM public.get_active_table_map(_company_id, (_date + _time)::timestamptz) LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', ts.id, 'section_id', ts.id, 'section_name', ts.name, 'payment_rule_section_id',s.id,
    'public_name', COALESCE(s.public_name,ts.name), 'description', s.description, 'amount_type', _rule.amount_type,
    'base_amount', CASE WHEN _rule.pricing_mode='by_section' THEN s.base_amount ELSE _rule.base_amount END,
    'pix_amount', CASE WHEN _rule.pricing_mode='by_section' THEN s.pix_amount ELSE _rule.pix_amount END,
    'credit_card_amount', CASE WHEN _rule.pricing_mode='by_section' THEN s.credit_card_amount ELSE _rule.credit_card_amount END,
    'capacity_guests',ss.capacity_guests,
    'available', COALESCE(_availability.available, false)
      AND (_rule.pricing_mode IS DISTINCT FROM 'by_section' OR s.id IS NOT NULL)
      AND public.reservation_section_capacity_available(_company_id,_date,_time,COALESCE(_availability.duration_minutes,30),_party_size,ts.id,NULL)
      AND (ss.capacity_guests IS NULL OR ss.capacity_guests>=_party_size+public.count_overlapping_reservation_section_guests(
        _company_id,_date,_time,COALESCE(_availability.duration_minutes,30),ts.id,NULL))
      AND CASE WHEN _availability.availability_mode='capacity' THEN
        COALESCE(ss.capacity_guests,0)>=_party_size+public.count_overlapping_reservation_section_guests(
          _company_id,_date,_time,COALESCE(_availability.duration_minutes,30),ts.id,NULL)
      ELSE public.pick_best_fit_reservation_section_table(_company_id, _date, _time,
        COALESCE(_availability.duration_minutes, 30), _party_size, _map_id, ts.id, NULL) IS NOT NULL END
  ) ORDER BY ss.sort_order,ss.id), '[]'::jsonb) INTO _options
  FROM public.reservation_schedule_rule_slot_sections ss
  JOIN public.table_sections ts ON ts.id=ss.section_id AND ts.company_id=_company_id
  LEFT JOIN public.reservation_payment_rule_sections s ON s.rule_id=_rule.id AND s.section_id=ts.id AND s.enabled
    AND _rule.pricing_mode='by_section'
  WHERE ss.slot_id=_slot.id AND ss.enabled;
  RETURN jsonb_build_object('enabled', true, 'rule_id', _rule.id, 'options', _options);
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_reservation_section_options(uuid,date,time,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_section_options(uuid,date,time,integer) TO anon, authenticated, service_role;

-- Called by the existing public RPC after its day/slot locks and schedule
-- resolution. The caller never chooses a table or supplies a trusted price.
CREATE FUNCTION public.resolve_public_reservation_section(
  _reservation jsonb, _company_id uuid, _date date, _time time, _party_size integer,
  _duration_minutes integer, _availability_mode text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _rule public.reservation_payment_rules; _option public.reservation_payment_rule_sections;
  _section_id uuid; _map_id uuid; _table_id uuid; _section_name text;
  _slot public.reservation_schedule_rule_slots; _slot_section public.reservation_schedule_rule_slot_sections;
BEGIN
  _section_id := NULLIF(_reservation->>'selected_section_id', '')::uuid;
  IF public.company_feature_enabled(_company_id, 'reservation_prepayment') THEN
    SELECT * INTO _rule FROM public.reservation_payment_rules
    WHERE company_id = _company_id AND enabled AND archived_at IS NULL AND _date BETWEEN date_start AND date_end
    ORDER BY created_at DESC, id LIMIT 1 FOR SHARE;
  END IF;
  _slot:=public.resolve_public_reservation_section_slot(_company_id,_date,_time);
  IF _slot.id IS NOT NULL THEN
    SELECT * INTO _slot FROM public.reservation_schedule_rule_slots WHERE id=_slot.id FOR SHARE;
  END IF;
  IF NOT COALESCE(_slot.allow_section_selection,false) THEN
    IF _rule.pricing_mode='by_section' THEN
      RAISE EXCEPTION 'A regra de pagamento por ambiente exige escolha de ambiente neste horario.';
    END IF;
    IF _section_id IS NOT NULL OR NULLIF(_reservation->>'section_option_id', '') IS NOT NULL THEN
      RAISE EXCEPTION 'A escolha de ambiente nao esta habilitada para este horario. Atualize a reserva.';
    END IF;
    RETURN jsonb_build_object('selected_section_id', NULL, 'selected_section_name', NULL);
  END IF;
  IF _rule.pricing_mode='single' THEN
    IF _section_id IS NOT NULL OR NULLIF(_reservation->>'section_option_id','') IS NOT NULL THEN
      RAISE EXCEPTION 'A reserva de valor unico aloca o ambiente automaticamente. Atualize a reserva para continuar.';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-capacity|%s|%s',_company_id::text,_date::text),0));
    _section_id:=public.pick_automatic_reservation_section(_company_id,_date,_time,_party_size,_duration_minutes,_availability_mode);
    IF _section_id IS NULL THEN RAISE EXCEPTION 'Nenhum ambiente disponivel para este horario e numero de pessoas.'; END IF;
  END IF;
  IF _section_id IS NULL THEN RAISE EXCEPTION 'Escolha o ambiente da reserva.'; END IF;
  SELECT * INTO _slot_section FROM public.reservation_schedule_rule_slot_sections
  WHERE slot_id=_slot.id AND section_id=_section_id AND company_id=_company_id AND enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ambiente indisponivel para este horario.'; END IF;
  SELECT name INTO _section_name FROM public.table_sections WHERE id=_section_id AND company_id=_company_id;
  IF _rule.pricing_mode='by_section' THEN
    SELECT * INTO _option FROM public.reservation_payment_rule_sections
    WHERE rule_id = _rule.id AND company_id = _company_id AND section_id = _section_id AND enabled;
    IF NOT FOUND OR (NULLIF(_reservation->>'section_option_id', '') IS NOT NULL
      AND (_reservation->>'section_option_id')::uuid <> _option.id) THEN
      RAISE EXCEPTION 'Ambiente indisponivel para esta regra de pagamento.';
    END IF;
    _section_name:=_option.public_name;
  ELSIF NULLIF(_reservation->>'section_option_id','') IS NOT NULL THEN
    RAISE EXCEPTION 'Opcao de preco por ambiente nao esta habilitada para este horario.';
  END IF;
  IF _availability_mode='capacity' THEN
    -- Same slot -> day -> table order as the established capacity entry points.
    PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-capacity|%s|%s',_company_id::text,_date::text),0));
    IF COALESCE(_slot_section.capacity_guests,0)<_party_size+public.count_overlapping_reservation_section_guests(
      _company_id,_date,_time,_duration_minutes,_section_id,NULL) THEN
      RAISE EXCEPTION 'Capacidade do ambiente atingida para este horario.';
    END IF;
  ELSE
    SELECT id INTO _map_id FROM public.get_active_table_map(_company_id, (_date + _time)::timestamptz) LIMIT 1;
    _table_id := public.pick_best_fit_reservation_section_table(
      _company_id, _date, _time, _duration_minutes, _party_size, _map_id, _section_id, NULL);
    IF _table_id IS NULL THEN RAISE EXCEPTION 'Ambiente indisponivel para este horario ou numero de pessoas.'; END IF;
  END IF;
  PERFORM public.enforce_reservation_section_capacity(_company_id,_date,_time,_duration_minutes,_party_size,_section_id,NULL);
  RETURN jsonb_build_object('selected_section_id', _section_id, 'selected_section_name', _section_name,
    'section_option_id', _option.id, 'table_id', _table_id, 'table_map_id', _map_id);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_public_reservation_section(jsonb,uuid,date,time,integer,integer,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the deployed public function, its OID, audit behavior and all
-- intervening schedule, phone, birthdate and concurrency fixes.
DO $patch_public_section$
DECLARE _definition text; _before text; _anchor text;
BEGIN
  _definition := replace(pg_get_functiondef('public.create_public_reservation(jsonb,text)'::regprocedure), E'\r\n', E'\n');
  IF position('reservation_section_pricing_resolution' IN _definition) = 0 THEN
    _before := _definition;
    _anchor := '  _effective_max_guests_per_slot := COALESCE(';
    IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public reservation section resolution anchor.'; END IF;
    _definition := replace(_definition, _anchor,
      E'  -- reservation_section_pricing_resolution: selected environment and table are server-authoritative.\n  _reservation := _reservation || public.resolve_public_reservation_section(\n    _reservation, _company_id, _date, _time, _party_size, _duration_minutes, _availability_mode);\n  _table_id := NULLIF(_reservation ->> ''table_id'', '''')::uuid;\n\n' || _anchor);
    _anchor := E'    created_in_mode\n  )';
    IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public reservation section columns anchor.'; END IF;
    _definition := replace(_definition, _anchor, E'    created_in_mode,\n    selected_section_id,\n    selected_section_name\n  )');
    _anchor := E'    _availability_mode\n  )';
    IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public reservation section values anchor.'; END IF;
    _definition := replace(_definition, _anchor,
      E'    _availability_mode,\n    NULLIF(_reservation ->> ''selected_section_id'', '''')::uuid,\n    NULLIF(_reservation ->> ''selected_section_name'', '''')\n  )');
    IF _definition = _before THEN RAISE EXCEPTION 'Public reservation section patch was not applied.'; END IF;
    EXECUTE _definition;
  END IF;
END;
$patch_public_section$;

-- Tables may also have a per-environment guest cap. Acquire the established
-- day-capacity lock before any table locks in every operational entry point.
DO $patch_section_capacity_locks$
DECLARE _name text; _signature regprocedure; _definition text; _anchor text;
BEGIN
  FOREACH _name IN ARRAY ARRAY[
    'public.create_public_reservation(jsonb,text)',
    'public.create_panel_reservation(uuid,date,time,integer,text,text,text,date,text,text,uuid,boolean,text,text)',
    'public.update_panel_reservation(uuid,date,time,integer,text,text,text,text,text,uuid,boolean,boolean,text)'
  ] LOOP
    _signature:=to_regprocedure(_name);
    IF _signature IS NULL THEN CONTINUE; END IF;
    _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
    IF position('reservation_section_capacity_lock' IN _definition)=0 THEN
      _anchor:='  _effective_max_guests_per_slot := COALESCE(';
      IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing section capacity lock anchor: %',_name; END IF;
      _definition:=replace(_definition,_anchor,E'  -- reservation_section_capacity_lock: slot -> day -> table.\n  IF public.reservation_section_capacity_enabled(_company.id,_date) THEN\n    PERFORM pg_advisory_xact_lock(hashtextextended(format(''reservation-capacity|%s|%s'',_company.id::text,_date::text),0));\n  END IF;\n\n'||_anchor);
      EXECUTE _definition;
    END IF;
  END LOOP;
  _signature:=COALESCE(to_regprocedure('public.assign_reservation_tables(uuid,uuid[],boolean,text,boolean)'),
    to_regprocedure('public.assign_reservation_tables(uuid,uuid[],boolean,text)'));
  IF _signature IS NOT NULL THEN
    _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
    IF position('reservation_section_capacity_lock' IN _definition)=0 THEN
      _anchor:='  IF cardinality(_normalized_table_ids) = 0 THEN';
      IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing assignment section capacity lock anchor.'; END IF;
      _definition:=replace(_definition,_anchor,E'  -- reservation_section_capacity_lock: slot -> day -> table.\n  IF public.reservation_section_capacity_enabled(_reservation.company_id,_reservation.date) THEN\n    PERFORM pg_advisory_xact_lock(hashtextextended(format(''reservation-capacity|%s|%s'',_reservation.company_id::text,_reservation.date::text),0));\n  END IF;\n\n'||_anchor);
      EXECUTE _definition;
    END IF;
  END IF;
  _signature:=to_regprocedure('public.confirm_reservation_payment(uuid,uuid,text,timestamptz,jsonb,text)');
  IF _signature IS NOT NULL THEN
    _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
    IF position('reservation_section_capacity_confirmation' IN _definition)=0 THEN
      _anchor:='    FOR _table_id IN';
      IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing payment section capacity anchor.'; END IF;
      _definition:=replace(_definition,_anchor,E'    -- reservation_section_capacity_confirmation: keep late receipts in financial history.\n    BEGIN\n      IF _reservation.selected_section_id IS NOT NULL AND NOT COALESCE(\n        (public.resolve_public_reservation_section_slot(_company_id,_reservation.date,_reservation.time)).allow_section_selection,false) THEN\n        _conflict:=true;\n      END IF;\n      PERFORM public.enforce_reservation_section_capacity(_company_id,_reservation.date,_reservation.time,\n        _duration,_reservation.party_size,COALESCE(_reservation.selected_section_id,(\n          SELECT ts.id FROM public.restaurant_tables t JOIN public.table_sections ts\n          ON ts.company_id=t.company_id AND ts.code=t.section WHERE t.id=_reservation.table_id\n        )),_reservation.id);\n    EXCEPTION WHEN raise_exception THEN _conflict:=true;\n    END;\n\n'||_anchor);
      EXECUTE _definition;
    END IF;
  END IF;
  _signature:=to_regprocedure('public.update_panel_reservation(uuid,date,time,integer,text,text,text,text,text,uuid,boolean,boolean,text)');
  IF _signature IS NOT NULL THEN
    _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
    IF position('reservation_section_auto_reassignment' IN _definition)=0 THEN
      _anchor:=E'      _resolved_table_id := public.pick_best_fit_reservation_table(\n        _reservation.company_id, _date, _time, _duration_minutes, _party_size, _active_table_map_id, _reservation_id\n      );';
      IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing panel section reassignment anchor.'; END IF;
      _definition:=replace(_definition,_anchor,E'      -- reservation_section_auto_reassignment: keep the contracted environment.\n      _resolved_table_id := CASE WHEN _reservation.selected_section_id IS NOT NULL\n        THEN public.pick_best_fit_reservation_section_table(_reservation.company_id,_date,_time,\n          _duration_minutes,_party_size,_active_table_map_id,_reservation.selected_section_id,_reservation_id)\n        ELSE public.pick_best_fit_reservation_table(\n          _reservation.company_id,_date,_time,_duration_minutes,_party_size,_active_table_map_id,_reservation_id) END;');
      EXECUTE _definition;
    END IF;
  END IF;
  _signature:=to_regprocedure('public._public_reservation_change_slot(uuid,date,time,integer)');
  IF _signature IS NOT NULL THEN
    _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
    IF position('reservation_section_public_change' IN _definition)=0 THEN
      _anchor:=E'      _table_id := public.pick_best_fit_reservation_table(_entry.company_id,_date,_time,\n        _duration,_party_size,_map_id,_entry.id);';
      IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing public change section assignment anchor.'; END IF;
      _definition:=replace(_definition,_anchor,E'      -- reservation_section_public_change: the customer keeps the same environment.\n      _table_id := CASE WHEN _entry.selected_section_id IS NOT NULL\n        THEN public.pick_best_fit_reservation_section_table(_entry.company_id,_date,_time,\n          _duration,_party_size,_map_id,_entry.selected_section_id,_entry.id)\n        ELSE public.pick_best_fit_reservation_table(_entry.company_id,_date,_time,\n          _duration,_party_size,_map_id,_entry.id) END;');
      _anchor:=E'  IF _reason IS NULL AND COALESCE(_schedule.availability_mode,''tables'') <> ''capacity'' THEN';
      IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing public change section availability anchor.'; END IF;
      _definition:=replace(_definition,_anchor,E'  IF _reason IS NULL AND (\n    (COALESCE(_slot.allow_section_selection,false) AND _entry.selected_section_id IS NULL)\n    OR (_entry.selected_section_id IS NOT NULL AND (NOT COALESCE(_slot.allow_section_selection,false) OR NOT EXISTS(\n      SELECT 1 FROM public.reservation_schedule_rule_slot_sections ss\n      WHERE ss.slot_id=_slot.id AND ss.section_id=_entry.selected_section_id AND ss.enabled\n        AND (ss.capacity_guests IS NULL OR ss.capacity_guests>=_party_size\n          +public.count_overlapping_reservation_section_guests(_entry.company_id,_date,_time,_duration,ss.section_id,_entry.id))\n    )))\n  ) THEN _reason:=''full''; END IF;\n\n'||_anchor);
      EXECUTE _definition;
    END IF;
  END IF;
END;
$patch_section_capacity_locks$;

-- The contracted environment is independent of the assigned table. Protect
-- every table write, including legacy panel writes and N:N table assignments.
CREATE FUNCTION public.guard_reservation_contracted_section()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _section_id uuid; _company_id uuid; _slot public.reservation_schedule_rule_slots; _reservation public.reservations;
BEGIN
  IF TG_TABLE_NAME = 'reservations' THEN
    IF TG_OP = 'UPDATE' AND OLD.selected_section_id IS NOT NULL AND (
      NEW.selected_section_id IS DISTINCT FROM OLD.selected_section_id
      OR NEW.selected_section_name IS DISTINCT FROM OLD.selected_section_name
      OR NEW.company_id IS DISTINCT FROM OLD.company_id
    ) THEN RAISE EXCEPTION 'O ambiente contratado nao pode ser alterado. Cancele e crie outra reserva para trocar de ambiente.'; END IF;
    _section_id := NEW.selected_section_id;
    _company_id := NEW.company_id;
    IF public.is_reservation_occupying_capacity(NEW.id,NEW.status,COALESCE(NEW.created_at,now())) AND (
      TG_OP='INSERT' OR NEW.date IS DISTINCT FROM OLD.date OR NEW.time IS DISTINCT FROM OLD.time
      OR NEW.party_size IS DISTINCT FROM OLD.party_size OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
      OR NEW.table_id IS DISTINCT FROM OLD.table_id OR NEW.created_in_mode IS DISTINCT FROM OLD.created_in_mode
      OR NOT public.is_reservation_occupying_capacity(OLD.id,OLD.status,OLD.created_at)
    ) THEN
      _slot:=public.resolve_public_reservation_section_slot(NEW.company_id,NEW.date,NEW.time);
      IF _section_id IS NOT NULL AND (NOT COALESCE(_slot.allow_section_selection,false) OR NOT EXISTS (
        SELECT 1 FROM public.reservation_schedule_rule_slot_sections ss WHERE ss.slot_id=_slot.id AND ss.section_id=_section_id AND ss.enabled
      )) THEN RAISE EXCEPTION 'Ambiente indisponivel para este horario.'; END IF;
      IF _section_id IS NULL AND NEW.table_id IS NOT NULL THEN
        SELECT s.id INTO _section_id FROM public.restaurant_tables t
        JOIN public.table_sections s ON s.company_id=t.company_id AND s.code=t.section WHERE t.id=NEW.table_id;
      END IF;
      PERFORM public.enforce_reservation_section_capacity(NEW.company_id,NEW.date,NEW.time,
        COALESCE(NEW.duration_minutes,30),NEW.party_size,_section_id,NEW.id);
      _section_id:=NEW.selected_section_id;
    END IF;
    IF _section_id IS NULL THEN RETURN NEW; END IF;
    IF NEW.created_in_mode='tables' AND NEW.table_id IS NULL THEN
      RAISE EXCEPTION 'A reserva de ambiente deve manter uma mesa alocada para garantir a disponibilidade.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.table_sections s WHERE s.id = _section_id AND s.company_id = _company_id) THEN
      RAISE EXCEPTION 'Ambiente invalido para esta empresa.';
    END IF;
    IF NEW.table_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.restaurant_tables t JOIN public.table_sections s ON s.company_id = t.company_id AND s.code = t.section
      WHERE t.id = NEW.table_id AND t.company_id = _company_id AND s.id = _section_id
    ) THEN RAISE EXCEPTION 'A mesa deve pertencer ao ambiente contratado.'; END IF;
  ELSE
    SELECT * INTO _reservation
    FROM public.reservations r WHERE r.id = NEW.reservation_id FOR SHARE;
    _section_id:=_reservation.selected_section_id;
    _company_id:=_reservation.company_id;
    IF _section_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.restaurant_tables t JOIN public.table_sections s ON s.company_id = t.company_id AND s.code = t.section
      WHERE t.id = NEW.table_id AND t.company_id = _company_id AND s.id = _section_id
    ) THEN RAISE EXCEPTION 'A mesa deve pertencer ao ambiente contratado.'; END IF;
    IF public.is_reservation_occupying_capacity(_reservation.id,_reservation.status,_reservation.created_at) THEN
      SELECT s.id INTO _section_id FROM public.restaurant_tables t
      JOIN public.table_sections s ON s.company_id=t.company_id AND s.code=t.section WHERE t.id=NEW.table_id;
      PERFORM public.enforce_reservation_section_capacity(_company_id,_reservation.date,_reservation.time,
        COALESCE(_reservation.duration_minutes,30),_reservation.party_size,_section_id,_reservation.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER aab_guard_reservation_contracted_section
BEFORE INSERT OR UPDATE ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.guard_reservation_contracted_section();
CREATE TRIGGER aab_guard_reservation_assignment_contracted_section
BEFORE INSERT OR UPDATE ON public.reservation_table_assignments
FOR EACH ROW EXECUTE FUNCTION public.guard_reservation_contracted_section();

REVOKE ALL ON FUNCTION public.validate_reservation_rule_section_pricing() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.validate_reservation_payment_rule_section() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_reservation_contracted_section() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.guard_table_contracted_section()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF (NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.section IS DISTINCT FROM OLD.section)
    AND EXISTS(SELECT 1 FROM public.reservations r
      JOIN public.table_sections s ON s.id=r.selected_section_id
      WHERE public.is_reservation_occupying_capacity(r.id,r.status,r.created_at)
        AND (r.table_id=OLD.id OR EXISTS(SELECT 1 FROM public.reservation_table_assignments a WHERE a.reservation_id=r.id AND a.table_id=OLD.id))
        AND (NEW.company_id<>s.company_id OR NEW.section<>s.code)) THEN
    RAISE EXCEPTION 'Esta mesa possui reserva de ambiente. Realoque a reserva dentro do ambiente contratado antes de mover a mesa.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER aab_guard_table_contracted_section BEFORE UPDATE OF company_id,section ON public.restaurant_tables
FOR EACH ROW EXECUTE FUNCTION public.guard_table_contracted_section();
REVOKE ALL ON FUNCTION public.guard_table_contracted_section() FROM PUBLIC,anon,authenticated,service_role;
