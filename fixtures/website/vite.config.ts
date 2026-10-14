/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// In dev, /quote and /version proxy to the api fixture (`wrangler dev`, port 8787).
// In preview/production set VITE_QUOTE_API_URL to the api origin at build time.
export default defineConfig({
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/quote": "http://localhost:8787",
      "/version": "http://localhost:8787",
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
