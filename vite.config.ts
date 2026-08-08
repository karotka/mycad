import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  // The boolean worker imports OCCT, which Vite code-splits into its own chunk.
  // Code-splitting a worker needs the ES output format; the default 'iife' cannot
  // express the dynamic imports and fails the build.
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
  test: {
    // `tsc -p tsconfig.electron.json` compiles electron/ — tests included — into
    // dist-electron, and vitest only ignores dist by default. Without this the
    // compiled copies run a second time, from the build output.
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**'],
    // A cold parallel run may initialize several independent 50 MB OCCT WASM
    // instances at once. On a busy machine that compilation alone can exceed
    // 30 seconds, while the same assertions are fast once OCCT is loaded.
    // Keep a bounded but realistic limit for a from-scratch CI/test run.
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
