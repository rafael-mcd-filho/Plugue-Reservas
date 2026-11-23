-- EXAMPLE ONLY. This file does not iterate automatically and is NOT a migration.
-- First read international_phone_rollout.md and inspect the preflight report.
-- Execute in an isolated/staging database whose message workers/webhooks are inactive.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

SELECT * FROM public.report_international_phone_migration('reservations', 'guest_phone', 500, NULL);

-- Deliberately commented out. Invoke a reviewed batch manually; copy its
-- last_scanned_id as _after in the next call. Keep the cursor even for invalid rows.
-- SELECT * FROM public.backfill_international_phone_batch('reservations', 'guest_phone', 500, NULL);
-- SELECT * FROM public.backfill_international_phone_batch('reservations', 'guest_phone', 500, '<last_scanned_id>'::uuid);

ROLLBACK;
