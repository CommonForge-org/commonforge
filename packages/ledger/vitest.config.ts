import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Older builds emitted source-adjacent tests into dist; never run those stale copies.
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
