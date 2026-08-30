import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: { usePolling: true },
    proxy: {
      // The Go monolith serves /api. Until it exists, VITE_USE_MOCK=1 short-circuits
      // the client before any request reaches this proxy.
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://app:8080', changeOrigin: true },
    },
  },
})
