/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.firefox';

/**
 * Build d'extension MV3 — port Firefox.
 *
 * Identique au `vite.config.ts` Chrome, à trois différences près :
 *
 * 1. `manifest` pointe sur `src/manifest.firefox.ts` (event page +
 *    `browser_specific_settings.gecko`, pas d'`offscreen`).
 * 2. `outDir` = `dist-firefox/` pour ne pas piétiner le build Chrome (`dist/`).
 *    Permet d'avoir les deux builds côte à côte (utile pour le dev et la CI).
 * 3. Pas d'entrée `offscreen.html` — le moteur d'export vit dans l'event page
 *    background (`src/firefox/background.ts`), pas dans un document offscreen.
 *
 * Le reste (Preact, target ES2022, @crxjs) est partagé pour que les deux
 * builds produisent un comportement identique côté UI / content scripts.
 */
export default defineConfig({
  plugins: [preact(), crx({ manifest, browser: 'firefox' })],
  build: {
    target: 'es2022',
    outDir: 'dist-firefox',
    emptyOutDir: true,
  },
});
