-- Limpa dados de clientes criados antes de 2026-04-14.
-- Corte considerado: 2026-04-14 00:00:00-03 (America/Fortaleza).
-- O filtro principal usa created_at, nao a data operacional da reserva/fila.
-- Assim, reservas de teste criadas antes do go-live tambem saem, mesmo se
-- estiverem marcadas para uma data futura.
--
-- O modulo de leads nao tem tabela propria. Os leads desaparecem ao remover:
-- - reservations
-- - reservation_companions
-- - waitlist
-- - waitlist_companions
--
-- Como usar:
-- 1. Rode em dry run primeiro e confira os NOTICEs.
-- 2. Se a contagem estiver correta, troque v_dry_run para false.
-- 3. Se quiser limitar a uma empresa, preencha v_scope_company_id.

DROP TABLE IF EXISTS purge_cleanup_summary;

CREATE TEMP TABLE purge_cleanup_summary (
  phase text NOT NULL,
  item text NOT NULL,
  row_count integer NOT NULL
);

DO $$
DECLARE
  v_dry_run boolean := true;
  v_scope_company_id uuid := null; -- null = todas as empresas
  v_cutoff_at constant timestamptz := timestamptz '2026-04-14 00:00:00-03';
  v_reservations integer := 0;
  v_reservation_companions integer := 0;
  v_waitlist integer := 0;
  v_waitlist_companions integer := 0;
  v_whatsapp_message_logs integer := 0;
  v_whatsapp_message_queue integer := 0;
  v_reservation_funnel_logs integer := 0;
  v_tracking_events integer := 0;
  v_tracking_journeys integer := 0;
  v_tracking_sessions integer := 0;
  v_meta_event_queue integer := 0;
  v_meta_event_attempts integer := 0;
BEGIN
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Pre-go-live cleanup';
  RAISE NOTICE 'Cutoff........: %', v_cutoff_at;
  RAISE NOTICE 'Company scope.: %', COALESCE(v_scope_company_id::text, 'ALL');
  RAISE NOTICE 'Dry run.......: %', v_dry_run;
  RAISE NOTICE '------------------------------------------------------------';

  CREATE TEMP TABLE purge_target_reservations ON COMMIT DROP AS
  SELECT r.id, r.company_id
  FROM public.reservations r
  WHERE r.created_at < v_cutoff_at
    AND (v_scope_company_id IS NULL OR r.company_id = v_scope_company_id);

  CREATE TEMP TABLE purge_target_reservation_companions ON COMMIT DROP AS
  SELECT rc.id
  FROM public.reservation_companions rc
  LEFT JOIN purge_target_reservations r
    ON r.id = rc.reservation_id
  WHERE (v_scope_company_id IS NULL OR rc.company_id = v_scope_company_id)
    AND (
      rc.created_at < v_cutoff_at
      OR r.id IS NOT NULL
    );

  CREATE TEMP TABLE purge_target_waitlist ON COMMIT DROP AS
  SELECT w.id, w.company_id
  FROM public.waitlist w
  WHERE w.created_at < v_cutoff_at
    AND (v_scope_company_id IS NULL OR w.company_id = v_scope_company_id);

  CREATE TEMP TABLE purge_target_waitlist_companions ON COMMIT DROP AS
  SELECT wc.id
  FROM public.waitlist_companions wc
  LEFT JOIN purge_target_waitlist w
    ON w.id = wc.waitlist_id
  WHERE (v_scope_company_id IS NULL OR wc.company_id = v_scope_company_id)
    AND (
      wc.created_at < v_cutoff_at
      OR w.id IS NOT NULL
    );

  CREATE TEMP TABLE purge_target_tracking_sessions ON COMMIT DROP AS
  SELECT ts.id, ts.company_id
  FROM public.tracking_sessions ts
  WHERE ts.created_at < v_cutoff_at
    AND (v_scope_company_id IS NULL OR ts.company_id = v_scope_company_id);

  CREATE TEMP TABLE purge_target_tracking_journeys ON COMMIT DROP AS
  SELECT tj.id, tj.company_id
  FROM public.tracking_journeys tj
  LEFT JOIN purge_target_tracking_sessions ts
    ON ts.id = tj.session_id
  LEFT JOIN purge_target_reservations r
    ON r.id = tj.reservation_id
  WHERE (v_scope_company_id IS NULL OR tj.company_id = v_scope_company_id)
    AND (
      tj.created_at < v_cutoff_at
      OR ts.id IS NOT NULL
      OR r.id IS NOT NULL
    );

  CREATE TEMP TABLE purge_target_tracking_events ON COMMIT DROP AS
  SELECT te.id, te.company_id
  FROM public.tracking_events te
  LEFT JOIN purge_target_tracking_sessions ts
    ON ts.id = te.session_id
  LEFT JOIN purge_target_tracking_journeys tj
    ON tj.id = te.journey_id
  LEFT JOIN purge_target_reservations r
    ON r.id = te.reservation_id
  WHERE (v_scope_company_id IS NULL OR te.company_id = v_scope_company_id)
    AND (
      te.created_at < v_cutoff_at
      OR ts.id IS NOT NULL
      OR tj.id IS NOT NULL
      OR r.id IS NOT NULL
    );

  CREATE TEMP TABLE purge_target_meta_event_queue ON COMMIT DROP AS
  SELECT meq.id, meq.company_id
  FROM public.meta_event_queue meq
  LEFT JOIN purge_target_reservations r
    ON r.id = meq.reservation_id
  LEFT JOIN purge_target_tracking_journeys tj
    ON tj.id = meq.journey_id
  LEFT JOIN purge_target_tracking_events te
    ON te.id = meq.tracking_event_id
  WHERE (v_scope_company_id IS NULL OR meq.company_id = v_scope_company_id)
    AND (
      meq.created_at < v_cutoff_at
      OR r.id IS NOT NULL
      OR tj.id IS NOT NULL
      OR te.id IS NOT NULL
    );

  CREATE TEMP TABLE purge_target_meta_event_attempts ON COMMIT DROP AS
  SELECT mea.id
  FROM public.meta_event_attempts mea
  LEFT JOIN purge_target_meta_event_queue meq
    ON meq.id = mea.queue_id
  LEFT JOIN purge_target_reservations r
    ON r.id = mea.reservation_id
  WHERE (v_scope_company_id IS NULL OR mea.company_id = v_scope_company_id)
    AND (
      mea.created_at < v_cutoff_at
      OR meq.id IS NOT NULL
      OR r.id IS NOT NULL
    );

  CREATE TEMP TABLE purge_target_whatsapp_message_logs ON COMMIT DROP AS
  SELECT wml.id
  FROM public.whatsapp_message_logs wml
  LEFT JOIN purge_target_reservations r
    ON r.id = wml.reservation_id
  WHERE (v_scope_company_id IS NULL OR wml.company_id = v_scope_company_id)
    AND (
      wml.created_at < v_cutoff_at
      OR r.id IS NOT NULL
    );

  CREATE TEMP TABLE purge_target_whatsapp_message_queue ON COMMIT DROP AS
  SELECT wmq.id
  FROM public.whatsapp_message_queue wmq
  LEFT JOIN purge_target_reservations r
    ON r.id = wmq.reservation_id
  WHERE (v_scope_company_id IS NULL OR wmq.company_id = v_scope_company_id)
    AND (
      wmq.created_at < v_cutoff_at
      OR r.id IS NOT NULL
    );

  CREATE TEMP TABLE purge_target_reservation_funnel_logs ON COMMIT DROP AS
  SELECT rfl.id
  FROM public.reservation_funnel_logs rfl
  WHERE rfl.created_at < v_cutoff_at
    AND (v_scope_company_id IS NULL OR rfl.company_id = v_scope_company_id);

  SELECT count(*) INTO v_reservations
  FROM purge_target_reservations;

  SELECT count(*) INTO v_reservation_companions
  FROM purge_target_reservation_companions;

  SELECT count(*) INTO v_waitlist
  FROM purge_target_waitlist;

  SELECT count(*) INTO v_waitlist_companions
  FROM purge_target_waitlist_companions;

  SELECT count(*) INTO v_whatsapp_message_logs
  FROM purge_target_whatsapp_message_logs;

  SELECT count(*) INTO v_whatsapp_message_queue
  FROM purge_target_whatsapp_message_queue;

  SELECT count(*) INTO v_reservation_funnel_logs
  FROM purge_target_reservation_funnel_logs;

  SELECT count(*) INTO v_tracking_events
  FROM purge_target_tracking_events;

  SELECT count(*) INTO v_tracking_journeys
  FROM purge_target_tracking_journeys;

  SELECT count(*) INTO v_tracking_sessions
  FROM purge_target_tracking_sessions;

  SELECT count(*) INTO v_meta_event_queue
  FROM purge_target_meta_event_queue;

  SELECT count(*) INTO v_meta_event_attempts
  FROM purge_target_meta_event_attempts;

  INSERT INTO purge_cleanup_summary (phase, item, row_count)
  VALUES
    ('targeted', 'reservations', v_reservations),
    ('targeted', 'reservation_companions', v_reservation_companions),
    ('targeted', 'waitlist', v_waitlist),
    ('targeted', 'waitlist_companions', v_waitlist_companions),
    ('targeted', 'whatsapp_message_logs', v_whatsapp_message_logs),
    ('targeted', 'whatsapp_message_queue', v_whatsapp_message_queue),
    ('targeted', 'reservation_funnel_logs', v_reservation_funnel_logs),
    ('targeted', 'tracking_events', v_tracking_events),
    ('targeted', 'tracking_journeys', v_tracking_journeys),
    ('targeted', 'tracking_sessions', v_tracking_sessions),
    ('targeted', 'meta_event_queue', v_meta_event_queue),
    ('targeted', 'meta_event_attempts', v_meta_event_attempts);

  RAISE NOTICE 'Rows targeted for cleanup:';
  RAISE NOTICE '  reservations............. %', v_reservations;
  RAISE NOTICE '  reservation_companions... %', v_reservation_companions;
  RAISE NOTICE '  waitlist................. %', v_waitlist;
  RAISE NOTICE '  waitlist_companions...... %', v_waitlist_companions;
  RAISE NOTICE '  whatsapp_message_logs.... %', v_whatsapp_message_logs;
  RAISE NOTICE '  whatsapp_message_queue... %', v_whatsapp_message_queue;
  RAISE NOTICE '  reservation_funnel_logs.. %', v_reservation_funnel_logs;
  RAISE NOTICE '  tracking_events.......... %', v_tracking_events;
  RAISE NOTICE '  tracking_journeys........ %', v_tracking_journeys;
  RAISE NOTICE '  tracking_sessions........ %', v_tracking_sessions;
  RAISE NOTICE '  meta_event_queue......... %', v_meta_event_queue;
  RAISE NOTICE '  meta_event_attempts...... %', v_meta_event_attempts;

  IF v_dry_run THEN
    INSERT INTO purge_cleanup_summary (phase, item, row_count)
    VALUES ('info', 'dry_run', 1);

    RAISE NOTICE 'Dry run ativo. Nenhum dado foi removido.';
    RETURN;
  END IF;

  DELETE FROM public.meta_event_attempts mea
  USING purge_target_meta_event_attempts target
  WHERE mea.id = target.id;
  GET DIAGNOSTICS v_meta_event_attempts = ROW_COUNT;

  DELETE FROM public.meta_event_queue meq
  USING purge_target_meta_event_queue target
  WHERE meq.id = target.id;
  GET DIAGNOSTICS v_meta_event_queue = ROW_COUNT;

  DELETE FROM public.whatsapp_message_queue wmq
  USING purge_target_whatsapp_message_queue target
  WHERE wmq.id = target.id;
  GET DIAGNOSTICS v_whatsapp_message_queue = ROW_COUNT;

  DELETE FROM public.whatsapp_message_logs wml
  USING purge_target_whatsapp_message_logs target
  WHERE wml.id = target.id;
  GET DIAGNOSTICS v_whatsapp_message_logs = ROW_COUNT;

  DELETE FROM public.reservation_funnel_logs rfl
  USING purge_target_reservation_funnel_logs target
  WHERE rfl.id = target.id;
  GET DIAGNOSTICS v_reservation_funnel_logs = ROW_COUNT;

  DELETE FROM public.tracking_events te
  USING purge_target_tracking_events target
  WHERE te.id = target.id;
  GET DIAGNOSTICS v_tracking_events = ROW_COUNT;

  DELETE FROM public.tracking_journeys tj
  USING purge_target_tracking_journeys target
  WHERE tj.id = target.id;
  GET DIAGNOSTICS v_tracking_journeys = ROW_COUNT;

  DELETE FROM public.tracking_sessions ts
  USING purge_target_tracking_sessions target
  WHERE ts.id = target.id;
  GET DIAGNOSTICS v_tracking_sessions = ROW_COUNT;

  DELETE FROM public.reservation_companions rc
  USING purge_target_reservation_companions target
  WHERE rc.id = target.id;
  GET DIAGNOSTICS v_reservation_companions = ROW_COUNT;

  DELETE FROM public.waitlist_companions wc
  USING purge_target_waitlist_companions target
  WHERE wc.id = target.id;
  GET DIAGNOSTICS v_waitlist_companions = ROW_COUNT;

  DELETE FROM public.reservations r
  USING purge_target_reservations target
  WHERE r.id = target.id;
  GET DIAGNOSTICS v_reservations = ROW_COUNT;

  DELETE FROM public.waitlist w
  USING purge_target_waitlist target
  WHERE w.id = target.id;
  GET DIAGNOSTICS v_waitlist = ROW_COUNT;

  INSERT INTO purge_cleanup_summary (phase, item, row_count)
  VALUES
    ('deleted', 'reservations', v_reservations),
    ('deleted', 'reservation_companions', v_reservation_companions),
    ('deleted', 'waitlist', v_waitlist),
    ('deleted', 'waitlist_companions', v_waitlist_companions),
    ('deleted', 'whatsapp_message_logs', v_whatsapp_message_logs),
    ('deleted', 'whatsapp_message_queue', v_whatsapp_message_queue),
    ('deleted', 'reservation_funnel_logs', v_reservation_funnel_logs),
    ('deleted', 'tracking_events', v_tracking_events),
    ('deleted', 'tracking_journeys', v_tracking_journeys),
    ('deleted', 'tracking_sessions', v_tracking_sessions),
    ('deleted', 'meta_event_queue', v_meta_event_queue),
    ('deleted', 'meta_event_attempts', v_meta_event_attempts);

  RAISE NOTICE 'Cleanup concluido:';
  RAISE NOTICE '  reservations............. %', v_reservations;
  RAISE NOTICE '  reservation_companions... %', v_reservation_companions;
  RAISE NOTICE '  waitlist................. %', v_waitlist;
  RAISE NOTICE '  waitlist_companions...... %', v_waitlist_companions;
  RAISE NOTICE '  whatsapp_message_logs.... %', v_whatsapp_message_logs;
  RAISE NOTICE '  whatsapp_message_queue... %', v_whatsapp_message_queue;
  RAISE NOTICE '  reservation_funnel_logs.. %', v_reservation_funnel_logs;
  RAISE NOTICE '  tracking_events.......... %', v_tracking_events;
  RAISE NOTICE '  tracking_journeys........ %', v_tracking_journeys;
  RAISE NOTICE '  tracking_sessions........ %', v_tracking_sessions;
  RAISE NOTICE '  meta_event_queue......... %', v_meta_event_queue;
  RAISE NOTICE '  meta_event_attempts...... %', v_meta_event_attempts;
END;
$$;

SELECT phase, item, row_count
FROM purge_cleanup_summary
ORDER BY
  CASE phase
    WHEN 'targeted' THEN 1
    WHEN 'deleted' THEN 2
    ELSE 3
  END,
  item;
