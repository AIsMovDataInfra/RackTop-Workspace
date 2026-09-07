import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 1421, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4318', changeOrigin: false } },
    watch: { ignored: ['**/server/**', '**/data/**', '**/tests/**'] },
  },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom', restoreMocks: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
})
