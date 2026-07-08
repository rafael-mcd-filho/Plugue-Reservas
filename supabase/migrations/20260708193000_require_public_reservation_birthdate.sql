-- Exige nascimento em novas reservas feitas pelo fluxo publico.
-- NOT VALID evita quebrar historico antigo que ainda nao tinha esse campo obrigatorio.

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_public_birthdate_required
  CHECK (visitor_id IS NULL OR guest_birthdate IS NOT NULL)
  NOT VALID;
