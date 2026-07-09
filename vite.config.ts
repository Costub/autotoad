import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP make the page cross-origin isolated, which enables SharedArrayBuffer.
// The same two headers are set for production in vercel.json.
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
