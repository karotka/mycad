import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
  test: {
    // `tsc -p tsconfig.electron.json` compiles electron/ — tests included — into
    // dist-electron, and vitest only ignores dist by default. Without this the
    // compiled copies run a second time, from the build output.
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**'],
  },
});
