-- Tela Clientes mais rápida: telefone e estado de cada cliente calculados sem
-- refazer o plano das funções a cada linha.
--
-- A tela Clientes (get_crm_leads_page) levava de 6 a 10 s nas unidades grandes e
-- passava do limite de 8 s em João Pessoa. Cerca de 80% do tempo ia em
-- phone_customer_identity_digits: é uma cadeia de funções SQL (até
-- is_valid_phone_e164) que o Postgres planeja de novo a cada registro, cerca de
-- 0,5 ms por telefone. O estado pelo DDD (_crm_phone_state_code) gastava mais
-- 0,15 ms e roda duas vezes por cliente.
--
-- 1. Cópias em plpgsql, com as mesmas regras e o mesmo resultado, só para a
--    leitura do CRM: _crm_is_valid_phone_e164, _crm_phone_to_e164,
--    _crm_phone_identity_digits e _crm_phone_customer_identity_digits. Passam a
--    ser usadas onde o CRM calcula o telefone de cada registro:
--    _get_crm_contact_records, _get_crm_contact_records_for_keys e os contatos
--    encontrados em _crm_search_customer_keys. A troca é feita sobre a definição
--    em vigor e falha se o trecho não aparecer o número de vezes esperado.
-- 2. _crm_phone_state_code e _crm_state_name passam para plpgsql, com as mesmas
--    regras.
--
-- Fica igual: phone_to_e164, is_valid_phone_e164, phone_identity_digits,
-- phone_customer_identity_digits e phone_stored_identity_digits, usadas em
-- índices, gatilhos e envios; o restante de cada função; as permissões; e o
-- resultado. Conferido no banco de produção em 23/11/2026: os 31.610 telefones e
-- as 23.323 fichas das 6 unidades saem iguais. Se as regras de telefone
-- mudarem, mude também estas cópias (o teste
-- supabase/tests/run_crm_global_customer_search_regression.mjs compara as duas).

CREATE OR REPLACE FUNCTION public._crm_is_valid_phone_e164(_phone text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Mesmo algoritmo e mesmo resultado de is_valid_phone_e164, com os laços
-- feitos por posição no jsonb, sem uma consulta por passo.
DECLARE
  _digits text;
  _national text;
  _plans jsonb;
  _plan jsonb;
  _types jsonb;
  _type jsonb;
  _lengths jsonb;
  _length_matches boolean;
  _calling_code_length integer;
BEGIN
  IF _phone IS NULL OR _phone !~ '^\+[1-9][0-9]{6,14}$' THEN
    RETURN false;
  END IF;
  _digits := substring(_phone FROM 2);
  FOR _size IN 1..3 LOOP
    _plans := public._phone_numbering_plans(left(_digits, _size));
    IF _plans IS NOT NULL THEN
      _calling_code_length := _size;
      EXIT;
    END IF;
  END LOOP;
  IF _plans IS NULL THEN
    RETURN false;
  END IF;
  _national := substring(_digits FROM _calling_code_length + 1);
  FOR _plan_index IN 0 .. jsonb_array_length(_plans) - 1 LOOP
    _plan := _plans -> _plan_index;
    _lengths := _plan -> 'lengths';
    _length_matches := false;
    IF _lengths IS NOT NULL THEN
      FOR _length_index IN 0 .. jsonb_array_length(_lengths) - 1 LOOP
        IF (_lengths ->> _length_index)::integer = length(_national) THEN
          _length_matches := true;
          EXIT;
        END IF;
      END LOOP;
    END IF;
    IF NOT _length_matches OR _national !~ ('^(?:' || (_plan ->> 'pattern') || ')$') THEN
      CONTINUE;
    END IF;
    _types := _plan -> 'types';
    IF jsonb_array_length(_types) = 0 THEN
      RETURN true;
    END IF;
    IF _types IS NOT NULL THEN
      FOR _type_index IN 0 .. jsonb_array_length(_types) - 1 LOOP
        _type := _types -> _type_index;
        _lengths := _type -> 'lengths';
        _length_matches := false;
        IF _lengths IS NOT NULL THEN
          FOR _length_index IN 0 .. jsonb_array_length(_lengths) - 1 LOOP
            IF (_lengths ->> _length_index)::integer = length(_national) THEN
              _length_matches := true;
              EXIT;
            END IF;
          END LOOP;
        END IF;
        IF _length_matches AND _national ~ ('^(?:' || (_type ->> 'pattern') || ')$') THEN
          RETURN true;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public._crm_phone_to_e164(_phone text, _country text DEFAULT 'BR'::text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Mesmo resultado de phone_to_e164.
DECLARE
  _raw text := btrim(COALESCE(_phone, ''));
  _digits text;
  _value text;
BEGIN
  IF _raw = '' OR _raw !~ '^\+?[0-9() .-]+$' THEN
    RETURN NULL;
  END IF;
  _digits := regexp_replace(COALESCE(_phone, ''), '\D', '', 'g');
  _value := CASE
    WHEN _raw LIKE '+%' AND _digits ~ '^[1-9][0-9]{6,14}$' THEN '+' || _digits
    WHEN upper(COALESCE(_country, 'BR')) = 'BR' AND _digits ~ '^[1-9][0-9]9?[0-9]{8}$' THEN '+55' || _digits
    WHEN upper(COALESCE(_country, 'BR')) = 'BR' AND _digits ~ '^55[1-9][0-9]9?[0-9]{8}$' THEN '+' || _digits
    ELSE NULL
  END;
  IF _value IS NULL OR NOT public._crm_is_valid_phone_e164(_value) THEN
    RETURN NULL;
  END IF;
  RETURN _value;
END;
$function$;

CREATE OR REPLACE FUNCTION public._crm_phone_identity_digits(_e164 text, _raw text, _country text DEFAULT 'BR'::text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Mesmo resultado de phone_identity_digits (phone_stored_identity_digits).
DECLARE
  _input text := COALESCE(NULLIF(btrim(_e164), ''), btrim(COALESCE(_raw, '')));
  _canonical text;
  _value text;
BEGIN
  _canonical := COALESCE(
    public._crm_phone_to_e164(_e164, 'ZZ'),
    public._crm_phone_to_e164(_raw, _country)
  );
  IF _canonical IS NOT NULL THEN
    RETURN substring(_canonical FROM 2);
  END IF;
  IF upper(COALESCE(_country, 'BR')) <> 'BR' OR _input !~ '^\+?[0-9() .-]+$' THEN
    RETURN NULL;
  END IF;
  _value := regexp_replace(_input, '\D', '', 'g');
  RETURN CASE
    WHEN _input LIKE '+%' AND _value ~ '^55[1-9][0-9](9?[0-9]{8})$' THEN _value
    WHEN _input NOT LIKE '+%' AND _value ~ '^[1-9][0-9](9?[0-9]{8})$' THEN '55' || _value
    WHEN _input NOT LIKE '+%' AND _value ~ '^55[1-9][0-9](9?[0-9]{8})$' THEN _value
    ELSE NULL
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public._crm_phone_customer_identity_digits(_e164 text, _raw text, _country text DEFAULT 'BR'::text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Mesmo resultado de phone_customer_identity_digits.
DECLARE
  _canonical text := public._crm_phone_identity_digits(_e164, _raw, _country);
  _digits text;
BEGIN
  IF _canonical IS NOT NULL THEN
    RETURN _canonical;
  END IF;
  _digits := regexp_replace(COALESCE(_raw, ''), '\D', '', 'g');
  RETURN CASE
    WHEN upper(COALESCE(_country, 'BR')) <> 'BR' OR _digits = '' THEN NULL
    WHEN _digits !~ '^55' AND length(_digits) <= 11 THEN '55' || _digits
    ELSE _digits
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public._crm_phone_state_code(_phone_normalized text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _digits text := regexp_replace(COALESCE(_phone_normalized, ''), '\D', '', 'g');
  _ddd text;
BEGIN
  IF _digits LIKE '55%' AND length(_digits) IN (12, 13) THEN
    _ddd := substring(_digits FROM 3 FOR 2);
  END IF;
  RETURN CASE
      WHEN _ddd = ANY (ARRAY['11','12','13','14','15','16','17','18','19']) THEN 'SP'
      WHEN _ddd = ANY (ARRAY['21','22','24']) THEN 'RJ'
      WHEN _ddd = ANY (ARRAY['27','28']) THEN 'ES'
      WHEN _ddd = ANY (ARRAY['31','32','33','34','35','37','38']) THEN 'MG'
      WHEN _ddd = ANY (ARRAY['41','42','43','44','45','46']) THEN 'PR'
      WHEN _ddd = ANY (ARRAY['47','48','49']) THEN 'SC'
      WHEN _ddd = ANY (ARRAY['51','53','54','55']) THEN 'RS'
      WHEN _ddd = '61' THEN 'DF'
      WHEN _ddd = ANY (ARRAY['62','64']) THEN 'GO'
      WHEN _ddd = ANY (ARRAY['65','66']) THEN 'MT'
      WHEN _ddd = '67' THEN 'MS'
      WHEN _ddd = '68' THEN 'AC'
      WHEN _ddd = '69' THEN 'RO'
      WHEN _ddd = ANY (ARRAY['92','97']) THEN 'AM'
      WHEN _ddd = '95' THEN 'RR'
      WHEN _ddd = ANY (ARRAY['91','93','94']) THEN 'PA'
      WHEN _ddd = '96' THEN 'AP'
      WHEN _ddd = '63' THEN 'TO'
      WHEN _ddd = ANY (ARRAY['98','99']) THEN 'MA'
      WHEN _ddd = ANY (ARRAY['86','89']) THEN 'PI'
      WHEN _ddd = ANY (ARRAY['85','88']) THEN 'CE'
      WHEN _ddd = '84' THEN 'RN'
      WHEN _ddd = '83' THEN 'PB'
      WHEN _ddd = ANY (ARRAY['81','87']) THEN 'PE'
      WHEN _ddd = '82' THEN 'AL'
      WHEN _ddd = '79' THEN 'SE'
      WHEN _ddd = ANY (ARRAY['71','73','74','75','77']) THEN 'BA'
      ELSE NULL
    END;
END;
$function$;

CREATE OR REPLACE FUNCTION public._crm_state_name(_state_code text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN CASE upper(COALESCE(_state_code, ''))
      WHEN 'AC' THEN 'Acre'
      WHEN 'AL' THEN 'Alagoas'
      WHEN 'AP' THEN 'Amapá'
      WHEN 'AM' THEN 'Amazonas'
      WHEN 'BA' THEN 'Bahia'
      WHEN 'CE' THEN 'Ceará'
      WHEN 'DF' THEN 'Distrito Federal'
      WHEN 'ES' THEN 'Espírito Santo'
      WHEN 'GO' THEN 'Goiás'
      WHEN 'MA' THEN 'Maranhão'
      WHEN 'MT' THEN 'Mato Grosso'
      WHEN 'MS' THEN 'Mato Grosso do Sul'
      WHEN 'MG' THEN 'Minas Gerais'
      WHEN 'PA' THEN 'Pará'
      WHEN 'PB' THEN 'Paraíba'
      WHEN 'PR' THEN 'Paraná'
      WHEN 'PE' THEN 'Pernambuco'
      WHEN 'PI' THEN 'Piauí'
      WHEN 'RJ' THEN 'Rio de Janeiro'
      WHEN 'RN' THEN 'Rio Grande do Norte'
      WHEN 'RS' THEN 'Rio Grande do Sul'
      WHEN 'RO' THEN 'Rondônia'
      WHEN 'RR' THEN 'Roraima'
      WHEN 'SC' THEN 'Santa Catarina'
      WHEN 'SP' THEN 'São Paulo'
      WHEN 'SE' THEN 'Sergipe'
      WHEN 'TO' THEN 'Tocantins'
      ELSE NULL
    END;
END;
$function$;

COMMENT ON FUNCTION public._crm_is_valid_phone_e164(text) IS
  'Cópia de is_valid_phone_e164 para a leitura do CRM. Manter o mesmo resultado.';
COMMENT ON FUNCTION public._crm_phone_to_e164(text, text) IS
  'Cópia de phone_to_e164 para a leitura do CRM. Manter o mesmo resultado.';
COMMENT ON FUNCTION public._crm_phone_identity_digits(text, text, text) IS
  'Cópia de phone_identity_digits para a leitura do CRM. Manter o mesmo resultado.';
COMMENT ON FUNCTION public._crm_phone_customer_identity_digits(text, text, text) IS
  'Cópia de phone_customer_identity_digits para a leitura do CRM. Manter o mesmo resultado.';

REVOKE ALL ON FUNCTION public._crm_is_valid_phone_e164(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._crm_phone_to_e164(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._crm_phone_identity_digits(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._crm_phone_customer_identity_digits(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

DO $rewire$
DECLARE
  _change record;
  _definition text;
  _occurrences integer;
BEGIN
  FOR _change IN
    SELECT *
    FROM (VALUES
      (
        1,
        'public._get_crm_contact_records(uuid)',
        $old$public\.phone_customer_identity_digits\($old$,
        $new$public._crm_phone_customer_identity_digits($new$,
        4
      ),
      (
        2,
        'public._get_crm_contact_records_for_keys(uuid,text[])',
        $old$public\.phone_customer_identity_digits\($old$,
        $new$public._crm_phone_customer_identity_digits($new$,
        4
      ),
      (
        3,
        'public._crm_search_customer_keys(uuid,text,text)',
        $old$public\.phone_customer_identity_digits\((\s*contact_rows\.phone_e164,)$old$,
        $new$public._crm_phone_customer_identity_digits(\1$new$,
        1
      )
    ) AS changes(step, signature, old_pattern, new_text, expected)
    ORDER BY step
  LOOP
    _definition := pg_get_functiondef(_change.signature::regprocedure);
    _occurrences := regexp_count(_definition, _change.old_pattern);
    IF _occurrences <> _change.expected THEN
      RAISE EXCEPTION 'Trecho esperado % vezes aparece % vezes em %',
        _change.expected, _occurrences, _change.signature;
    END IF;
    EXECUTE regexp_replace(_definition, _change.old_pattern, _change.new_text, 'g');
  END LOOP;
END
$rewire$;
