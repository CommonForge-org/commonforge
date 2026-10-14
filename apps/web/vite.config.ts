import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The browser app and the API share one origin (cookie session + CSRF origin check).
 * - Production: the Worker serves `dist/` as static assets, `/api/*` runs the Worker first and
 *   every other path falls back to `index.html` (SPA), so `/auth/verify?token=` loads the app.
 *   Proposed `apps/worker/wrangler.jsonc` entry (not applied here; see the Task 20 report):
 *   "assets": { "directory": "../web/dist", "not_found_handling": "single-page-application",
 *               "run_worker_first": ["/api/*"] }
 * - Development: Vite proxies `/api` to `wrangler dev` on :8787 (override with COMMONFORGE_API);
 *   the page origin http://localhost:5173 is the Worker's default COMMONFORGE_APP_URL.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.COMMONFORGE_API ?? "http://localhost:8787", changeOrigin: false } },
  },
  preview: {
    proxy: { "/api": { target: process.env.COMMONFORGE_API ?? "http://localhost:8787", changeOrigin: false } },
  },
});
