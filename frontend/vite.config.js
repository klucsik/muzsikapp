import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { configDefaults } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  test: {
    ...configDefaults,
    environment: 'jsdom',
  },
  build: {
    outDir: '../backend/public',
    emptyOutDir: true,
  },
  server: {
    // Tunnel/ingress hostnames need explicit allowlisting since Vite 6 (localhost always ok).
    // The leading dot lets any subdomain of klucsik.hu through, so redeploys under a new
    // prefix keep working.
    allowedHosts: ['.klucsik.hu'],
    // When the dev server itself needs to own :3000, run the API elsewhere and point
    // BACKEND_URL at it, e.g. BACKEND_URL=http://localhost:3001.
    proxy: (() => {
      const backend = process.env.BACKEND_URL || 'http://localhost:3000';
      return {
        '/api': backend,
        '/audio': backend,
        '/socket.io': { target: backend, ws: true },
      };
    })(),
  },
})
