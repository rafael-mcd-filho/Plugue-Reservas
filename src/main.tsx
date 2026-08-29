import { isPublicApplicationPath } from "@/lib/publicRoutes";
import "./index.css";

const usePublicApplication = isPublicApplicationPath(window.location.pathname);

if (usePublicApplication) {
  void import("./PublicAppEntry.tsx");
}

if (!usePublicApplication) {
  void import("./AppEntry.tsx");
}
