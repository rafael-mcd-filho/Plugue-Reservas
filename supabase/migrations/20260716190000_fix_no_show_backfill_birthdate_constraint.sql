-- Mantem a exigencia de nascimento para novas reservas publicas sem impedir
-- atualizacoes operacionais em reservas historicas que antecedem essa regra.
ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS reservations_public_birthdate_required;

CREATE OR REPLACE FUNCTION public.enforce_public_reservation_birthdate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.visitor_id IS NOT NULL AND NEW.guest_birthdate IS NULL THEN
    RAISE EXCEPTION 'guest_birthdate is required for public reservations'
      USING ERRCODE = '23514',
            CONSTRAINT = 'reservations_public_birthdate_required';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reservations_public_birthdate_required
  ON public.reservations;

CREATE TRIGGER trg_reservations_public_birthdate_required
BEFORE INSERT OR UPDATE OF visitor_id, guest_birthdate
ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_public_reservation_birthdate();

COMMENT ON FUNCTION public.enforce_public_reservation_birthdate()
IS 'Exige nascimento ao criar uma reserva publica ou alterar seu visitante/nascimento, sem bloquear atualizacoes operacionais do historico legado.';

-- Reservas corrigidas em lote nao devem gerar uma mensagem tardia de no-show.
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS suppress_no_show_message boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.reservations.suppress_no_show_message
IS 'Impede o envio da automacao de no-show para correcoes administrativas ou retroativas.';

-- A selecao nao filtra empresa: saneia integralmente todas as contas.
UPDATE public.reservations
SET suppress_no_show_message = true
WHERE status = 'confirmed'
  AND date < ((now() AT TIME ZONE 'America/Fortaleza')::date);

SELECT public.mark_confirmed_reservations_as_no_show(
  ((now() AT TIME ZONE 'America/Fortaleza')::date)
);
