# Plug Guest platform billing (read-only) deploy runbook

This module mirrors Plug Guest SaaS invoices from a single global Asaas
account. It is independent from the existing per-company Asaas reservation
prepayment flow.

The module is safe-by-default:

- `platform_billing_config.module_enabled` is seeded as `false`.
- Every `company_billing_links.billing_enabled` switch defaults to `false`.
- The four-hour cron performs no HTTP request while the module is disabled.
- The provider helper only implements `GET` requests.
- No customer, subscription or payment is created, changed or deleted in Asaas.
- Companies without a link or without explicit per-company release are ignored
  by the automatic job. Superadmins can still preview and manually sync them.
- Operators have no access to billing tables or financial-detail RPCs. Their
  only billing RPC is `get_company_billing_overdue_warning`, which returns two
  booleans for the persistent overdue warning and exposes no amount, count or date.
- Company admins can only read invoices when both the global switch and their
  company's switch are enabled; superadmins retain access for a controlled pilot.

## Required secrets

Set these before saving the first token or running either Edge Function:

```powershell
supabase secrets set PLATFORM_BILLING_TOKEN_ENCRYPTION_KEY="<32-random-bytes-base64>"
supabase secrets set INTERNAL_JOB_SECRET="<same-value-used-by-public.system_settings>"
```

`PLATFORM_BILLING_TOKEN_ENCRYPTION_KEY` encrypts the global Asaas token with
AES-GCM before it is written to `platform_billing_config`. Back it up in the
approved secret manager: losing or rotating this key makes the stored token
undecryptable until the token is entered again.

Optional, normally unset:

```powershell
supabase secrets set PLATFORM_ASAAS_USER_AGENT="PlugueGuestPlatformBilling/1.0"
```

`PLATFORM_ASAAS_API_BASE_URL` is intentionally separate from
`ASAAS_API_BASE_URL`, which belongs to reservation prepayments. When the
override is unset, the selected config environment resolves to:

- Sandbox: `https://api-sandbox.asaas.com/v3`
- Production: `https://api.asaas.com/v3`

Production accepts only the exact official HTTPS origin and `/v3` base path.
An invalid override fails before `fetch`, so the global `access_token` is never
sent to HTTP, another Asaas environment, or an arbitrary host.

Only a controlled Sandbox proxy may override the default. It requires both an
explicit gate and an exact HTTPS origin allowlist (origins have no path):

```powershell
supabase secrets set PLATFORM_ASAAS_ALLOW_BASE_URL_OVERRIDE="true"
supabase secrets set PLATFORM_ASAAS_ALLOWED_BASE_URL_ORIGINS="https://asaas-proxy.example.com"
supabase secrets set PLATFORM_ASAAS_API_BASE_URL="https://asaas-proxy.example.com/asaas/v3"
```

The override origin must match the allowlist exactly, including a non-default
port. Credentials, query strings, fragments, HTTP, localhost, IP literals and
`.local` hosts are rejected. Never enable this gate merely to bypass a URL
validation error, and remove all three override secrets after the Sandbox proxy
test is complete.

The cron reads its `x-job-secret` from `public.system_settings`. Confirm that
the stored `internal_job_secret` value exactly matches the Edge secret:

```sql
UPDATE public.system_settings
SET value = '<same INTERNAL_JOB_SECRET>', updated_at = now()
WHERE key = 'internal_job_secret';
```

Never commit either secret or the Asaas token.

## Apply without activating

1. Apply migrations in timestamp order.
2. Deploy `platform-billing-config` and `platform-billing`.
3. Confirm the singleton remains disabled:

```sql
SELECT module_enabled, api_environment, token_last_four, token_validated_at,
       token_last_error
FROM public.platform_billing_config
WHERE id = true;
```

Expected initially: `module_enabled = false` and no token metadata.

4. Confirm `sync-platform-billing-invoices` exists in `cron.job`. Its presence
   does not activate synchronization; its SQL guard returns `NULL` while the
   module is disabled.

## Configure and pilot

Use `platform-billing-config` as an authenticated superadmin:

- `{"action":"test","api_token":"...","environment":"sandbox"}` validates
  a candidate token without saving it.
- `{"action":"save","api_token":"...","environment":"sandbox"}` validates,
  encrypts and saves it. The raw token is never returned.
- `{"action":"get"}` returns only masked metadata.
- `{"action":"set_enabled","enabled":true}` enables the global prerequisite.
  It does not release any company by itself.

Saving over an existing token, even in the same environment, is treated as a
change of Asaas source/account. The operation automatically:

- sets `module_enabled = false`;
- purges the rebuildable invoice cache;
- marks every company link `pending_validation`;
- resets every per-company `billing_enabled` switch to `false`.

This prevents invoices from one Asaas account or environment from appearing
under another. Revalidate each Customer ID with the new source before enabling
the module again.

Use `platform-billing` as a superadmin:

- `search_customers`: lists customers with safe offset pagination and can filter
  by Customer ID, name, email, CPF/CNPJ or external reference. It only performs
  `GET /customers`/`GET /customers/{id}` and never exposes the global token.
- `validate_customer`: validates a Customer ID with `GET /customers/{id}`.
- `save_link`: saves the unique Customer ID and fixed description marker, then makes
  an initial read-only synchronization. New links remain disabled for customers
  and cron until explicitly released.
- `set_company_enabled`: enables or disables customer visibility and automatic
  synchronization for one company. Enabling requires a currently active,
  validated link; disabling is fail-safe and preserves the link/cache.
- `sync_company`: synchronizes one company and can run while the global module
  is disabled for a controlled pilot.
- `sync_all`: is a no-op while the module is disabled and otherwise processes
  only companies whose `billing_enabled` switch is true.
- `remove_link`: deletes only the local link/cache; it changes nothing in Asaas.
- `get_invoice_pix_qr_code`: resolves an internal invoice ID inside the caller's
  company, validates the cached and live payment, then reads
  `GET /payments/{id}/pixQrCode`. It never accepts an arbitrary Asaas payment ID
  from the browser and never stores or audits the QR image or copy-and-paste
  payload.

Apply `20260817140000_add_platform_billing_pix_rate_limit.sql` before deploying
the Edge Function that exposes Pix. Requests fail closed if either internal RPC
is missing. One transaction claims all three Pix-generation buckets: shared
token (1 generation/second and 30/minute), company (1 generation/2 seconds and
30/minute), and user (1 generation/10 seconds and 6/minute). Each generation
performs at most two Asaas GETs, so this flow is capped at 60 provider reads per
minute. If any bucket rejects the request, none of their counters is consumed
and the API returns `retry_after_seconds`.

The Pix response is fenced against source rotation, relinking, rollout changes
and cache replacement after the provider reads and again after the audit. The
second database check is deliberately the final awaited operation on the
successful path. State can still change after that database snapshot and before
the HTTP bytes leave the Edge process; this final non-transactional interval is
unavoidable because the Asaas reads and the local database cannot share one
transaction.

The only accepted marker is exactly `[PLUGUEGUEST]`; custom or broader markers
are rejected by both the Edge Function and a database constraint. A payment is
mirrored only if its description contains that complete marker,
case-insensitively. The API cannot filter payment descriptions, so every page from
`GET /payments?customer=<id>&limit=100&offset=<n>` is read before filtering.

After a complete successful pagination pass, cache replacement is atomic:
stale payments and payments whose marker was removed disappear from the local
cache. A failed API pass keeps the previous good cache and records an error.
The link counters `last_fetched_count`, `last_matched_count` and
`last_ignored_count` make marker typos observable.

Every synchronization receives a unique attempt revision. Cache replacement
and error persistence require the same source, company link and attempt
revisions that started the request. Therefore, if jobs overlap, the last
started synchronization is the only one allowed to finish; an older/slower
response cannot overwrite newer cache data or mark a newer success as failed.
Saving/removing a company link or replacing the global token also invalidates
requests that are already in flight. Disabling a company also bumps its link
revision, so an already-running automatic sync cannot publish a late result.

A malformed successful (`2xx`) payments response is rejected before cache
replacement. If Asaas returns `401` or `403` for the current token and current
sync attempt, the module is automatically disabled and the validation error is
stored. The source/attempt revision checks prevent an old provider response
from disabling a newly saved token. Test the saved token and explicitly enable
the module again only after fixing the credential.

Company admins may request a manual sync at most once every five minutes.
Superadmins and the scheduled job bypass that UI abuse cooldown.

Operational caveat: the official Asaas documentation advises against using
`GET /payments` for continuous status polling and recommends webhooks, warning
that excessive polling may lead to API-key blocking. The four-hour full sync is
an explicit MVP tradeoff for this webhook-free rollout. Keep the module
disabled until the pilot volume is known, monitor provider errors/rate limits,
and plan a webhook or incremental reconciliation before scaling broadly. If a
current sync receives `401`/`403`, the global run stops before starting the next
batch (at most the already-running batch of four requests can finish).

## Activation checklist

1. Validate the token in Sandbox.
2. Link one test company and confirm its cached payments match Asaas exactly.
3. Verify a payment without `[PLUGUEGUEST]` is counted as ignored and not shown.
4. Verify a marker removal deletes the cached invoice after a successful sync.
5. Verify an operator cannot select billing tables or call financial-detail
   RPCs, and can only read the boolean overdue warning for their own company.
6. Verify an admin from another company cannot access the pilot company.
7. Exercise the manual-sync five-minute cooldown.
8. Confirm amounts, due dates and paid statuses in the company panel.
9. Test the six-day overdue threshold using the `America/Fortaleza` date.
10. Save/set the Production token; this intentionally disables the module and
    invalidates Sandbox links/cache.
11. Revalidate Production Customer IDs, run manual pilot syncs and compare.
12. Call global `set_enabled` only after the Production checks pass.
13. Call `set_company_enabled` for a single pilot company, verify its admin UI,
    badge, overdue popup, persistent warning and next automatic sync, then release other companies
    gradually.

## Emergency stop and rollback

Disable immediately through `set_enabled`, or with SQL if the Edge Function is
unavailable:

```sql
UPDATE public.platform_billing_config
SET module_enabled = false, updated_at = now()
WHERE id = true;
```

This stops scheduled provider reads and allows the frontend feature flag to
hide the module. It does not affect reservations, tracking, CAPI, the existing
Asaas reservation integration, or any object in Asaas. The new tables may stay
in place as dormant cache; no destructive migration rollback is required.

To stop only one company while keeping the global pilot active, use the
superadmin `set_company_enabled` action with `enabled:false`. This preserves the
last good cache for preview, immediately blocks company-admin access, removes
the company from cron, and fences any synchronization already in flight.
