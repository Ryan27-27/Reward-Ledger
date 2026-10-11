import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api is proxied to the Node server, so the browser sees ONE origin:
// the HttpOnly refresh cookie stays SameSite=Strict and no CORS is involved.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: process.env.API_URL || 'http://localhost:4000', changeOrigin: false } } },
});
