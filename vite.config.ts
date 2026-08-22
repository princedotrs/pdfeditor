import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // pdf.js ships its worker as an ESM file; Vite bundles it through the
  // `new URL(..., import.meta.url)` reference in src/core/engine.ts.
  worker: { format: 'es' },
  optimizeDeps: { include: ['pdfjs-dist'] },
  build: { target: 'es2022' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Core tests are pure Node; only the component tests need a DOM, so the
    // environment is opted into per file with `@vitest-environment jsdom`.
    environment: 'node',
    setupFiles: ['src/ui/test-setup.ts'],
  },
})
