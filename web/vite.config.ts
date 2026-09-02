/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command }) => {
  const env = loadEnv(command === "build" ? "production" : "development", process.cwd(), "");
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["src/test/setup.ts"],
      css: false,
      env: {
        VITE_COGNITO_DOMAIN: env.VITE_COGNITO_DOMAIN,
        VITE_CLIENT_ID: env.VITE_CLIENT_ID,
        VITE_API_URL: env.VITE_API_URL,
        VITE_REDIRECT_URI: env.VITE_REDIRECT_URI,
      },
    },
  };
});
