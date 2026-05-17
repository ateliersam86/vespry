/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

// Build d'extension MV3. @crxjs gère les content scripts, le service worker,
// le HMR et l'émission du manifeste. La config Vitest est colocalisée.
export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  build: {
    target: 'es2022',
    rollupOptions: {
      // Page d'extension chargée à l'exécution par chrome.offscreen — pas
      // déclarée dans le manifeste, donc explicitée en point d'entrée.
      input: { offscreen: 'src/offscreen/offscreen.html' },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
