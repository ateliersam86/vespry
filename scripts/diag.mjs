#!/usr/bin/env node
/** Diagnostic : le token injecté charge-t-il encore la session Discord ? */
import { launchWithToken, overlayText } from './harness.mjs';

const TOKEN = process.env.VESPRY_TEST_TOKEN;
if (!TOKEN) { console.log('VESPRY_TEST_TOKEN requis'); process.exit(1); }

const { ctx, cleanup } = await launchWithToken(TOKEN);
const d = await ctx.newPage();
await d.goto('https://discord.com/channels/@me', { waitUntil: 'load', timeout: 45_000 })
  .catch(() => {});
console.log('URL Discord :', d.url());

await d.locator('#vespry-launch-btn').click({ timeout: 20_000 })
  .catch((e) => console.log('clic launcher :', String(e)));
await d.waitForSelector('#vespry-overlay-host', { state: 'attached', timeout: 10_000 })
  .catch(() => {});
await d.waitForTimeout(22_000);

const txt = await overlayText(d);
const servers = await d.evaluate(() => {
  const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
  return r?.querySelectorAll('.v-sic').length ?? 0;
});
console.log('overlay (300c) :', txt.slice(0, 300));
console.log('icônes serveurs dans le rail :', servers);

await cleanup();
