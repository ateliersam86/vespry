#!/usr/bin/env node
/**
 * Test E2E complet — pilote l'overlay comme un utilisateur réel :
 * jeton injecté → ouverture de l'overlay → filtre de date → sélection d'un
 * salon → option média → ajout à la file → export RÉEL → fin → panneau
 * Soutiens → minimize.
 *
 * Profil neuf à chaque run, jeton injecté (cf. harness.mjs) : pas de
 * dépendance à une session Discord connectée, pas de staleness de profil.
 *
 * Usage : VESPRY_TEST_TOKEN="..." node scripts/e2e-test.mjs
 */
import { launchWithToken, overlayText } from './harness.mjs';

const TOKEN = process.env.VESPRY_TEST_TOKEN;
if (!TOKEN) { console.log('VESPRY_TEST_TOKEN requis'); process.exit(1); }

const steps = [];
const ok = (m) => { steps.push(`✓ ${m}`); };
let failed = null;

const { ctx, cleanup } = await launchWithToken(TOKEN);

/** Attend une condition dans le Shadow DOM de l'overlay. */
const waitOverlay = (page, fn, timeout) =>
  page.waitForFunction(fn, undefined, { timeout, polling: 500 });

try {
  const d = await ctx.newPage();

  // 1. Ouvrir une page Discord — le content script y injecte le lanceur.
  //    Pas besoin d'être connecté : le jeton vient déjà du stockage.
  await d.goto('https://discord.com/channels/@me', { waitUntil: 'load', timeout: 45_000 });
  const launcher = d.locator('#vespry-launch-btn');
  await launcher.waitFor({ state: 'visible', timeout: 20_000 });
  ok('page Discord chargée, lanceur Vespry injecté');

  // 2. Ouvrir l'overlay.
  await launcher.click();
  await d.waitForSelector('#vespry-overlay-host', { state: 'attached', timeout: 10_000 });
  ok('overlay ouvert');

  // 3. Attendre le chargement de la session (serveurs depuis l'API Discord).
  await waitOverlay(d, () => {
    const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return Boolean(r && /Images/.test(r.textContent ?? ''));
  }, 50_000);
  ok('session chargée, serveurs récupérés');

  // 4. Filtre de date — borné à aujourd'hui (export petit et rapide).
  const today = new Date().toISOString().slice(0, 10);
  await d.locator('.v-date').first().fill(today);
  ok(`filtre de date appliqué (depuis ${today})`);

  // 5. Attendre la liste des salons.
  await waitOverlay(d, () => {
    const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return (r?.querySelectorAll('.v-crow').length ?? 0) > 3;
  }, 45_000);
  ok('liste des salons chargée');

  // 6. Sélectionner le premier salon et vérifier que le compteur bouge.
  const sumBefore = await d.evaluate(() =>
    document.getElementById('vespry-overlay-host')?.shadowRoot
      ?.querySelector('.v-sum')?.textContent ?? '');
  await d.locator('.v-crow .v-cbx').first().click();
  await waitOverlay(d, (before) => {
    const s = document.getElementById('vespry-overlay-host')?.shadowRoot
      ?.querySelector('.v-sum')?.textContent ?? '';
    return s !== before && /[1-9]/.test(s);
  }, 8000);
  ok('1 salon sélectionné (compteur mis à jour)');

  // 7. Basculer une option média (Vidéos).
  await d.locator('.v-mchip', { hasText: /Vidéos|Videos/ }).click();
  ok('option média basculée');

  // 8. Ajouter à la file → lance l'export RÉEL.
  await d.locator('.v-btn', { hasText: /Ajouter|Add to queue/ }).first().click();
  ok('tâche ajoutée à la file — export lancé');

  // 9. Attendre la fin de l'export.
  await waitOverlay(d, () => {
    const t = document.getElementById('vespry-overlay-host')?.shadowRoot?.textContent ?? '';
    return /TERMIN|PARTIEL|\.zip/i.test(t);
  }, 120_000);
  ok('export terminé, paquet .zip prêt');

  // 10. Panneau Soutiens.
  await d.locator('.v-support-link').first().click();
  await waitOverlay(d, () => {
    const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return Boolean(r?.querySelector('.v-credits'));
  }, 8000);
  ok('panneau Soutiens ouvert');
  await d.locator('.v-credits .v-link').first().click(); // retour

  // 11. Minimize → widget flottant.
  await d.locator('.v-close[title="Réduire"]').click();
  await waitOverlay(d, () => {
    const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return Boolean(r?.querySelector('.v-mini'));
  }, 8000);
  ok('minimize → widget flottant');

  steps.push(`— état final : ${(await overlayText(d)).slice(0, 120)}`);
} catch (e) {
  failed = String(e);
}

await cleanup();

console.log('=== TEST E2E ===');
console.log(steps.join('\n'));
if (failed) console.log(`\n❌ ÉCHEC : ${failed}`);
console.log(`\n=== ${failed ? '❌ ÉCHEC' : '✅ PARCOURS COMPLET OK'} ===`);
process.exit(failed ? 1 : 0);
