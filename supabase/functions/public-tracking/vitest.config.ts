import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "npm:libphonenumber-js@1.13.15/max": "libphonenumber-js/max" } },
  test: {
    environment: "node",
    include: ["supabase/functions/public-tracking/*.test.ts"],
  },
});
