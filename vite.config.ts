import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

const packageJson = JSON.parse(fs.readFileSync("./package.json", "utf-8"));

function getGitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "local";
  }
}

const buildInfo = {
  version: packageJson.version || "0.0.0",
  commit: getGitCommit(),
  builtAt: new Date().toISOString(),
};

const publicPageIconModules = new Set([
  "banknote",
  "calendar-check",
  "clock",
  "credit-card",
  "external-link",
  "loader-circle",
  "map-pin",
  "phone",
  "qr-code",
  "star",
  "wallet",
]);

function getManualChunk(id: string) {
  const normalizedId = id.replace(/\\/g, "/");
  const iconMatch = normalizedId.match(/\/lucide-react\/dist\/esm\/icons\/([^/]+)\.js$/);
  if (iconMatch && publicPageIconModules.has(iconMatch[1])) {
    return "public-icons";
  }

  return undefined;
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(buildInfo.version),
    __APP_COMMIT__: JSON.stringify(buildInfo.commit),
    __APP_BUILT_AT__: JSON.stringify(buildInfo.builtAt),
  },
  build: {
    rollupOptions: {
      output: {
        // The restaurant page uses this small, stable icon set above the fold.
        // Keeping it together avoids a separate HTTP request per icon on 4G.
        manualChunks: getManualChunk,
      },
    },
  },
}));
