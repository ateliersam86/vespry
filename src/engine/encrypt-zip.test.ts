/**
 * Tests du moteur de chiffrement AES-256 (Phase 4).
 *
 * Couvre :
 * - Roundtrip chiffre/déchiffre avec le bon mot de passe.
 * - Refus du mot de passe vide (garde-fou).
 * - Mauvais mot de passe → erreur (pas de récupération silencieuse).
 * - Jauge `estimatePasswordStrength` sur les cas limites.
 */
import { describe, expect, it } from 'vitest';
import {
  BlobReader, BlobWriter, ZipReader, ZipWriter,
  type Entry,
} from '@zip.js/zip.js';
import { encryptZipBlob, estimatePasswordStrength } from './encrypt-zip';

/** Fabrique un zip non chiffré contenant `fichiers` (clé → contenu texte). */
async function makeZip(files: Record<string, string>): Promise<Blob> {
  const out = new BlobWriter('application/zip');
  const writer = new ZipWriter(out);
  for (const [name, content] of Object.entries(files)) {
    await writer.add(name, new BlobReader(new Blob([content])));
  }
  return writer.close();
}

/**
 * Déchiffre l'entrée intérieure d'un wrapper produit par `encryptZipBlob`.
 * Renvoie le Blob d'origine (le zip Conflux non chiffré).
 *
 * On reste sur zip.js pour le déchiffrement — c'est lui qui implémente
 * AES, donc un roundtrip via sa propre API valide bien la sortie.
 */
async function decryptInner(
  wrapper: Blob,
  password: string,
  innerName = 'export.zip',
): Promise<Blob> {
  const reader = new ZipReader(new BlobReader(wrapper), { password });
  const entries: Entry[] = await reader.getEntries();
  // L'API zip.js distingue `FileEntry` (avec `getData`) et `DirectoryEntry`
  // (sans). On utilise le discriminant `directory: false` exposé pour
  // narrow proprement vers FileEntry.
  const inner = entries.find(
    (e) => e.filename === innerName && e.directory === false,
  );
  if (!inner || inner.directory !== false) {
    throw new Error(`entrée intérieure introuvable : ${innerName}`);
  }
  const writer = new BlobWriter('application/zip');
  const blob = await inner.getData(writer);
  await reader.close();
  return blob;
}

describe('encryptZipBlob', () => {
  it('roundtrip : chiffre puis déchiffre rend le zip d\'origine intact', async () => {
    const original = await makeZip({ 'json/general.json': '[{"msg":"hello"}]' });
    const wrapper = await encryptZipBlob(original, 'CorrectHorseBattery42');

    // Le wrapper est lui-même un zip valide (signature PK).
    const head = new Uint8Array(await wrapper.slice(0, 2).arrayBuffer());
    expect(head[0]).toBe(0x50); // P
    expect(head[1]).toBe(0x4b); // K

    const restored = await decryptInner(wrapper, 'CorrectHorseBattery42');
    const restoredBytes = new Uint8Array(await restored.arrayBuffer());
    const originalBytes = new Uint8Array(await original.arrayBuffer());
    expect(restoredBytes.byteLength).toBe(originalBytes.byteLength);
    for (let i = 0; i < restoredBytes.byteLength; i += 1) {
      expect(restoredBytes[i]).toBe(originalBytes[i]);
    }
  });

  it('refuse un mot de passe vide (garde-fou explicite)', async () => {
    const blob = await makeZip({ 'a.txt': 'data' });
    await expect(encryptZipBlob(blob, '')).rejects.toThrow(/mot de passe/iu);
  });

  it('mauvais mot de passe à l\'ouverture → erreur (pas de récupération)', async () => {
    const original = await makeZip({ 'a.txt': 'secret' });
    const wrapper = await encryptZipBlob(original, 'BonMotDePasse123!');

    // zip.js lève une erreur explicite quand le password ne match pas
    // l'en-tête AES (mauvais code MAC).
    await expect(decryptInner(wrapper, 'MauvaisMotDePasse'))
      .rejects.toThrow();
  });

  it('respecte `innerName` quand fourni', async () => {
    const original = await makeZip({ 'a.txt': 'data' });
    const wrapper = await encryptZipBlob(original, 'pwd-correct-1234', {
      innerName: 'vespry-Mon Serveur.zip',
    });
    // On peut lister sans déchiffrer — les noms d'entrées ne sont PAS
    // chiffrés en zip standard (seul le contenu l'est).
    const reader = new ZipReader(new BlobReader(wrapper));
    const entries = await reader.getEntries();
    expect(entries.map((e) => e.filename)).toEqual(['vespry-Mon Serveur.zip']);
    await reader.close();
  });
});

describe('estimatePasswordStrength', () => {
  it('renvoie `empty` pour une chaîne vide', () => {
    expect(estimatePasswordStrength('')).toBe('empty');
  });

  it('renvoie `weak` sur < 8 caractères', () => {
    expect(estimatePasswordStrength('Ab1!')).toBe('weak');
    expect(estimatePasswordStrength('aaaaaa')).toBe('weak'); // 6 char, 1 classe
  });

  it('renvoie `weak` sur ≥ 8 caractères mais 1 seule classe', () => {
    // 10 caractères mais que des minuscules → pas assez varié.
    expect(estimatePasswordStrength('aaaaaaaaaa')).toBe('weak');
    expect(estimatePasswordStrength('1234567890')).toBe('weak');
  });

  it('renvoie `medium` sur ≥ 8 caractères ET 2 classes', () => {
    expect(estimatePasswordStrength('motdepasse1')).toBe('medium'); // 11 char, 2 classes
    expect(estimatePasswordStrength('Password')).toBe('medium'); // 8 char, 2 classes
  });

  it('renvoie `strong` sur ≥ 12 caractères ET 3+ classes', () => {
    expect(estimatePasswordStrength('CorrectHorseBattery42!')).toBe('strong');
    expect(estimatePasswordStrength('Tr0ub4dor&3')).toBe('medium'); // 11 char (1 trop court)
    expect(estimatePasswordStrength('Tr0ub4dor&31')).toBe('strong'); // 12 char, 4 classes
  });
});
