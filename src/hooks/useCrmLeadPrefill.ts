import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const MIN_CRM_LEAD_PREFILL_PHONE_DIGITS = 10;

export interface CrmLeadPrefill {
  id: string;
  full_name: string | null;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  birthdate: string | null;
}

interface PrefillCandidate {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  birthdate: string | null;
  created_at: string | null;
}

function cleanText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function pickLatest(candidates: PrefillCandidate[], field: 'full_name' | 'phone' | 'email' | 'birthdate') {
  return candidates.find((candidate) => cleanText(candidate[field]))?.[field] ?? null;
}

export function useCrmLeadPrefill(
  companyId: string | null | undefined,
  phoneDigits: string,
  enabled = true,
) {
  const normalizedPhone = phoneDigits.trim();
  const phoneVariants = Array.from(new Set([
    normalizedPhone,
    normalizedPhone.length === 11 ? `55${normalizedPhone}` : normalizedPhone,
  ].filter(Boolean)));
  const buildPhoneFilter = (columns: string[]) =>
    phoneVariants.flatMap((phone) => columns.map((column) => `${column}.eq.${phone}`)).join(',');

  return useQuery({
    queryKey: ['crm-lead-prefill', companyId, normalizedPhone],
    queryFn: async () => {
      const [
        importedResult,
        reservationResult,
        reservationCompanionResult,
        waitlistResult,
        waitlistCompanionResult,
      ] = await Promise.all([
        supabase
          .from('crm_leads' as never)
          .select('id, full_name, phone, phone_normalized, email, birthdate, imported_at, created_at')
          .eq('company_id', companyId!)
          .or(buildPhoneFilter(['phone_normalized', 'phone']))
          .order('imported_at', { ascending: false })
          .limit(10),
        supabase
          .from('reservations' as never)
          .select('id, guest_name, guest_phone, guest_email, guest_birthdate, created_at')
          .eq('company_id', companyId!)
          .or(buildPhoneFilter(['guest_phone']))
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('reservation_companions' as never)
          .select('id, name, phone, email, birthdate, created_at')
          .eq('company_id', companyId!)
          .or(buildPhoneFilter(['phone']))
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('waitlist' as never)
          .select('id, guest_name, guest_phone, guest_email, guest_birthdate, created_at')
          .eq('company_id', companyId!)
          .or(buildPhoneFilter(['guest_phone']))
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('waitlist_companions' as never)
          .select('id, name, phone, email, birthdate, created_at')
          .eq('company_id', companyId!)
          .or(buildPhoneFilter(['phone']))
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      const error = importedResult.error
        ?? reservationResult.error
        ?? reservationCompanionResult.error
        ?? waitlistResult.error
        ?? waitlistCompanionResult.error;

      if (error) throw error;

      const candidates: PrefillCandidate[] = [
        ...(((importedResult.data ?? []) as any[]).map((lead) => ({
          id: `crm-${lead.id}`,
          full_name: cleanText(lead.full_name),
          phone: cleanText(lead.phone) ?? cleanText(lead.phone_normalized),
          email: cleanText(lead.email),
          birthdate: cleanText(lead.birthdate),
          created_at: cleanText(lead.imported_at) ?? cleanText(lead.created_at),
        })) satisfies PrefillCandidate[]),
        ...(((reservationResult.data ?? []) as any[]).map((reservation) => ({
          id: `reservation-${reservation.id}`,
          full_name: cleanText(reservation.guest_name),
          phone: cleanText(reservation.guest_phone),
          email: cleanText(reservation.guest_email),
          birthdate: cleanText(reservation.guest_birthdate),
          created_at: cleanText(reservation.created_at),
        })) satisfies PrefillCandidate[]),
        ...(((reservationCompanionResult.data ?? []) as any[]).map((companion) => ({
          id: `reservation-companion-${companion.id}`,
          full_name: cleanText(companion.name),
          phone: cleanText(companion.phone),
          email: cleanText(companion.email),
          birthdate: cleanText(companion.birthdate),
          created_at: cleanText(companion.created_at),
        })) satisfies PrefillCandidate[]),
        ...(((waitlistResult.data ?? []) as any[]).map((entry) => ({
          id: `waitlist-${entry.id}`,
          full_name: cleanText(entry.guest_name),
          phone: cleanText(entry.guest_phone),
          email: cleanText(entry.guest_email),
          birthdate: cleanText(entry.guest_birthdate),
          created_at: cleanText(entry.created_at),
        })) satisfies PrefillCandidate[]),
        ...(((waitlistCompanionResult.data ?? []) as any[]).map((companion) => ({
          id: `waitlist-companion-${companion.id}`,
          full_name: cleanText(companion.name),
          phone: cleanText(companion.phone),
          email: cleanText(companion.email),
          birthdate: cleanText(companion.birthdate),
          created_at: cleanText(companion.created_at),
        })) satisfies PrefillCandidate[]),
      ]
        .filter((candidate) => candidate.full_name || candidate.phone || candidate.email || candidate.birthdate)
        .sort((left, right) => (right.created_at ?? '').localeCompare(left.created_at ?? ''));

      if (candidates.length === 0) {
        return null;
      }

      return {
        id: candidates[0].id,
        full_name: pickLatest(candidates, 'full_name'),
        phone: pickLatest(candidates, 'phone') ?? normalizedPhone,
        phone_normalized: normalizedPhone,
        email: pickLatest(candidates, 'email'),
        birthdate: pickLatest(candidates, 'birthdate'),
      } satisfies CrmLeadPrefill;
    },
    enabled: Boolean(
      enabled
        && companyId
        && normalizedPhone.length >= MIN_CRM_LEAD_PREFILL_PHONE_DIGITS,
    ),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
