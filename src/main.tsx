import { getPublicApplicationCompanySlug, isPublicApplicationPath } from "@/lib/publicRoutes";
import { applyCachedFavicon } from "@/lib/publicCompanyIcons";
import "./index.css";

const pathname = window.location.pathname;
const usePublicApplication = isPublicApplicationPath(pathname);

// Applies a favicon remembered from a previous visit before any data has loaded,
// so the tab doesn't flash the default icon while the real logo is fetched.
applyCachedFavicon('system');
if (usePublicApplication) {
  const companySlug = getPublicApplicationCompanySlug(pathname);
  if (companySlug) applyCachedFavicon(`company:${companySlug}`);
  void import("./PublicAppEntry.tsx");
} else {
  void import("./AppEntry.tsx");
}
