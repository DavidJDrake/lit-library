/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import process from "node:process";
import { defineConfig, loadEnv } from "vite";

const REQUIRED_ENV_KEYS = ["VITE_COGNITO_DOMAIN", "VITE_CLIENT_ID", "VITE_API_URL", "VITE_REDIRECT_URI"] as const;

export default defineConfig(({ command, mode }) => {
  const proxyTarget = loadEnv(mode, process.cwd(), "VITE_").VITE_DEV_PROXY_TARGET;

  if (command === "build") {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    const missing = REQUIRED_ENV_KEYS.filter((k) => !env[k]);
    if (missing.length) throw new Error(`Missing ${missing.join(", ")}`);
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: proxyTarget
        ? {
            "/api": { target: proxyTarget, changeOrigin: true },
            "/catalog.json": { target: proxyTarget, changeOrigin: true },
            "/covers": { target: proxyTarget, changeOrigin: true },
          }
        : undefined,
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["src/test/setup.ts"],
      css: false,
    },
  };
});
