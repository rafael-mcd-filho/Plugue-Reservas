-- These read models return one JSON value per RPC call and paginate inside SQL.
-- Consequently, PostgREST's max_rows setting does not cap the nested result.
-- The former page <= 10000 validation was an unrelated artificial ceiling:
-- with the report's 12-row page it made customers after position 120,000
-- unreachable. Keep page_size bounded, but allow every positive integer page
-- and calculate offsets as bigint so the multiplication cannot overflow.

DO $migration$
DECLARE
  _signature regprocedure;
  _definition text;
  _updated_definition text;
BEGIN
  FOREACH _signature IN ARRAY ARRAY[
    'public.get_crm_leads_page(uuid,integer,integer,text,date,date,text,integer,integer,integer)'::regprocedure,
    'public.get_crm_lead_presence_history(uuid,text,integer,integer)'::regprocedure,
    'public._get_customer_recurrence_report_without_min_filter(uuid,date,date,boolean,integer,integer,text,text)'::regprocedure
  ]
  LOOP
    _definition := pg_get_functiondef(_signature);

    _updated_definition := replace(
      _definition,
      E'  _offset integer;',
      E'  _offset bigint;'
    );
    IF _updated_definition = _definition THEN
      RAISE EXCEPTION 'Nao foi possivel promover o offset de % para bigint.', _signature;
    END IF;
    _definition := _updated_definition;

    _updated_definition := replace(
      _definition,
      E'  IF _page IS NULL OR _page < 1 OR _page > 10000 THEN\n    RAISE EXCEPTION ''page deve estar entre 1 e 10000.'' USING ERRCODE = ''22023'';\n  END IF;',
      E'  IF _page IS NULL OR _page < 1 THEN\n    RAISE EXCEPTION ''page deve ser maior ou igual a 1.'' USING ERRCODE = ''22023'';\n  END IF;'
    );
    IF _updated_definition = _definition THEN
      RAISE EXCEPTION 'Nao foi possivel remover o teto de pagina de %.', _signature;
    END IF;
    _definition := _updated_definition;

    _updated_definition := replace(
      _definition,
      E'  _offset := (_page - 1) * _page_size;',
      E'  _offset := (_page::bigint - 1) * _page_size::bigint;'
    );
    IF _updated_definition = _definition THEN
      RAISE EXCEPTION 'Nao foi possivel proteger o calculo de offset de %.', _signature;
    END IF;

    EXECUTE _updated_definition;
  END LOOP;

  -- The public recurrence wrapper delegates validation to the internal report,
  -- but recalculates the customer page when min_total_visits is present.
  _signature := 'public.get_customer_recurrence_report(uuid,date,date,boolean,integer,integer,text,text,integer)'::regprocedure;
  _definition := pg_get_functiondef(_signature);

  _updated_definition := replace(
    _definition,
    E'  _offset integer;',
    E'  _offset bigint;'
  );
  IF _updated_definition = _definition THEN
    RAISE EXCEPTION 'Nao foi possivel promover o offset de % para bigint.', _signature;
  END IF;
  _definition := _updated_definition;

  _updated_definition := replace(
    _definition,
    E'  _offset := (_page - 1) * _page_size;',
    E'  _offset := (_page::bigint - 1) * _page_size::bigint;'
  );
  IF _updated_definition = _definition THEN
    RAISE EXCEPTION 'Nao foi possivel proteger o calculo de offset de %.', _signature;
  END IF;

  EXECUTE _updated_definition;
END;
$migration$;

COMMENT ON FUNCTION public.get_crm_leads_page(
  uuid, integer, integer, text, date, date, text, integer, integer, integer
)
IS 'Lista CRM paginada no servidor, sem teto artificial de pagina, com identidades normalizadas, filtros e contagem vitalicia de presencas canonicas.';

COMMENT ON FUNCTION public.get_crm_lead_presence_history(uuid, text, integer, integer)
IS 'Historico de presencas canonicas paginado no servidor, sem teto artificial de pagina.';

COMMENT ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text, integer
)
IS 'Relatorio agregado de recorrencia com clientes paginados no servidor sem teto artificial de pagina, busca e filtro minimo de visitas.';
