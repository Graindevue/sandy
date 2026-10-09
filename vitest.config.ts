import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@sandy/manifest-builder': fileURLToPath(
        new URL('./packages/manifest-builder/src/main.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.config/**', '**/_generated/**'],
    // Packages without tests yet (e.g. shared-types, convex-backend) shouldn't fail the run.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/dist/**', '**/*.test.ts', '**/*.config.ts'],
    },
  },
});
