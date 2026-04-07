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
}));
