import { handleProcessPlatformWhatsAppNotices } from "../_shared/platform-whatsapp-notices-worker.ts";

Deno.serve(req => handleProcessPlatformWhatsAppNotices(req));
