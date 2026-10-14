import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

// Unit tests only: the Playwright suites in e2e/ run with `pnpm test:e2e` (playwright.config.ts).
export default mergeConfig(viteConfig, defineConfig({ test: { exclude: [...configDefaults.exclude, "e2e/**"] } }));
