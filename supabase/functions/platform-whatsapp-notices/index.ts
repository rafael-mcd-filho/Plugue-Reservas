import { handlePlatformWhatsAppNotices } from "../_shared/platform-whatsapp-notices-api.ts";

Deno.serve(req => handlePlatformWhatsAppNotices(req));
