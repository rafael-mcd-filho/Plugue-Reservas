import { useSystemBranding } from '@/hooks/useSettings';
import { useFaviconOverride } from '@/lib/publicCompanyIcons';

/** Load the platform fallback for every route, including pages without a company logo. */
export default function SystemFavicon() {
  const { data } = useSystemBranding();
  useFaviconOverride(data?.system_logo_url);
  return null;
}
