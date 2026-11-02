/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Port 4200 and the /api proxy match the backend's CORS origin, the e-mailed sign-in link base
// (Authentication:Trainee:SignInLinkBaseUrl) and the Google OAuth "authorized JavaScript origin" for development.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4200,
    strictPort: true,
    proxy: { '/api': { target: 'http://localhost:5106', changeOrigin: false } },
  },
  build: { sourcemap: false },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
