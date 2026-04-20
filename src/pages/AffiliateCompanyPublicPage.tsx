import { useEffect } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import CompanyPublicPage from '@/pages/CompanyPublicPage';
import { getVisitorId } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';
import {
  clearAffiliateAttribution,
  isValidAffiliateLinkCode,
  normalizeAffiliateLinkCode,
  setAffiliateAttribution,
} from '@/lib/affiliateLinks';
import { isValidCompanySlug } from '@/lib/validation';

interface ResolvedAffiliateLink {
  id: string;
  company_id: string;
  company_name: string;
  company_slug: string;
  reference_name: string;
  code: string;
}

export default function AffiliateCompanyPublicPage() {
  const location = useLocation();
  const { slug, code } = useParams<{ slug: string; code: string }>();
  const normalizedCode = normalizeAffiliateLinkCode(code);
  const slugIsValid = isValidCompanySlug(slug);
  const codeIsValid = isValidAffiliateLinkCode(normalizedCode);

  const { data: affiliateLink, isFetched } = useQuery({
    queryKey: ['public-affiliate-link', slug, normalizedCode],
    queryFn: async () => {
      const url = typeof window !== 'undefined' ? new URL(window.location.href) : null;

      const { data, error } = await (supabase as any).rpc('resolve_public_affiliate_link', {
        _slug: slug!,
        _code: normalizedCode,
        _visitor_id: getVisitorId(),
        _page_url: url?.href ?? null,
        _path: `${location.pathname}${location.search}`,
        _referrer: typeof document !== 'undefined' ? document.referrer || null : null,
        _utm_source: url?.searchParams.get('utm_source') ?? null,
        _utm_medium: url?.searchParams.get('utm_medium') ?? null,
        _utm_campaign: url?.searchParams.get('utm_campaign') ?? null,
        _user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      });

      if (error) throw error;

      const rows = (data ?? []) as ResolvedAffiliateLink[];
      return rows[0] ?? null;
    },
    enabled: slugIsValid && codeIsValid,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!affiliateLink) return;

    setAffiliateAttribution({
      companyId: affiliateLink.company_id,
      companySlug: affiliateLink.company_slug,
      affiliateLinkId: affiliateLink.id,
      code: affiliateLink.code,
      referenceName: affiliateLink.reference_name,
      landingPath: `${location.pathname}${location.search}`,
    });
  }, [affiliateLink, location.pathname, location.search]);

  useEffect(() => {
    if (!isFetched || affiliateLink || !slug) return;
    clearAffiliateAttribution(slug);
  }, [affiliateLink, isFetched, slug]);

  if (!slugIsValid || !codeIsValid) {
    return <Navigate to={slug ? `/${slug}` : '/'} replace />;
  }

  if (isFetched && !affiliateLink) {
    return <Navigate to={`/${slug}`} replace />;
  }

  return <CompanyPublicPage />;
}
