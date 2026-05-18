/**
 * Chiffrement AES-256 du paquet d'export — Phase 4.
 *
 * Pourquoi un wrapper. Conflux (utilisé par `packager.ts`) produit un zip
 * streaming SANS support natif du chiffrement — y greffer AES exigerait de
 * forker la lib. La stratégie pragmatique : on **encapsule** le zip Conflux
 * dans un second zip qui contient une unique entrée chiffrée. C'est un
 * wrapper léger, lu par 7-Zip / Keka / WinRAR sans effort, et qui repose
 * sur l'implémentation AES-256 officielle de `@zip.js/zip.js` (WebCrypto
 * sous le capot, audit possible).
 *
 * Format wrapper :
 *
 *   vespry-<guild>.zip               ← le `Blob` renvoyé par cette fonction
 *   └── vespry-<guild>.zip            ← entrée AES-256, contient le zip métier
 *
 * À l'ouverture, l'utilisateur tape son mot de passe et extrait l'entrée
 * intérieure ; il obtient alors le zip Conflux d'origine, lisible normalement.
 *
 * Limites assumées :
 * - **ZipCrypto rejeté volontairement** — l'algo zip standard est trivial à
 *   casser (rainbow tables disponibles). On exige AES-256 (`encryptionStrength: 3`)
 *   sans option de fallback.
 * - Chiffrement par mot de passe → la **sécurité dépend de la force du mot
 *   de passe**. Cf. `estimatePasswordStrength` pour la jauge UI.
 * - Mode `STORED` (pas de compression dans le wrapper) — l'entrée intérieure
 *   est elle-même un zip déjà compressé, recompresser serait pure perte de
 *   CPU et taille.
 *
 * Référence : https://github.com/gildas-lormeau/zip.js — `encryptionStrength: 3`
 * = AES-256 (1 = AES-128, 2 = AES-192).
 */
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';

/** Niveau d'`encryptionStrength` zip.js correspondant à AES-256. */
const AES_256 = 3 as const;

export interface EncryptZipOptions {
  /**
   * Nom du fichier intérieur (entrée chiffrée). C'est le nom que verra
   * l'utilisateur quand il ouvre le wrapper avec 7-Zip / Keka. Défaut :
   * `export.zip` — neutre, sans information leakée.
   */
  innerName?: string;
}

/**
 * Chiffre un Blob (typiquement le zip Conflux d'un export) en AES-256 et
 * renvoie un nouveau Blob, lui-même un zip valide qui contient l'entrée
 * chiffrée. Le `Blob` renvoyé a `type === 'application/zip'`.
 *
 * Lève si `password` est vide — l'appelant DOIT vérifier en amont qu'un
 * mot de passe a bien été saisi (la fonction n'est pas une no-op). C'est
 * un garde-fou : un mot de passe vide produirait un zip techniquement
 * chiffré mais déverrouillable instantanément.
 */
export async function encryptZipBlob(
  source: Blob,
  password: string,
  opts: EncryptZipOptions = {},
): Promise<Blob> {
  if (!password || password.length === 0) {
    throw new Error('encryptZipBlob: mot de passe vide refusé');
  }
  const innerName = opts.innerName ?? 'export.zip';

  // BlobWriter assemble la sortie en mémoire — adapté à des paquets jusqu'à
  // quelques centaines de Mo. Au-delà on devrait passer à un Writer streaming
  // (cf. FileSystemFileHandle), mais ce n'est pas la cible des exports Discord
  // typiques (un gros serveur sans médias = ~50 Mo).
  const out = new BlobWriter('application/zip');
  const zipWriter = new ZipWriter(out, { bufferedWrite: true });
  await zipWriter.add(innerName, new BlobReader(source), {
    encryptionStrength: AES_256,
    password,
    // Compression désactivée — l'entrée est elle-même un zip Conflux déjà
    // compressé en interne, recompresser serait inutile et coûteux en CPU.
    level: 0,
  });
  return zipWriter.close();
}

/**
 * Catégorie de force d'un mot de passe — alimente la jauge UI (Phase B).
 *
 * Heuristique simple et raisonnable, pas un calcul d'entropie zxcvbn :
 *
 * | catégorie | critères cumulatifs |
 * |---|---|
 * | `empty`  | aucun caractère |
 * | `weak`   | < 8 caractères OU une seule classe de caractères |
 * | `medium` | ≥ 8 caractères ET ≥ 2 classes |
 * | `strong` | ≥ 12 caractères ET ≥ 3 classes |
 *
 * Les classes : minuscules, majuscules, chiffres, symboles.
 *
 * Choix d'implémentation : pas de dépendance à `zxcvbn` (~800 ko gzip,
 * disproportionné pour une jauge dans un coin de modale). Pour les
 * utilisateurs qui veulent une analyse fine, un mot de passe random
 * de 12+ caractères tirés par un gestionnaire est de toute façon ce
 * qu'on recommande dans la doc.
 */
export type PasswordStrength = 'empty' | 'weak' | 'medium' | 'strong';

export function estimatePasswordStrength(password: string): PasswordStrength {
  if (!password || password.length === 0) return 'empty';
  let classes = 0;
  if (/[a-z]/u.test(password)) classes += 1;
  if (/[A-Z]/u.test(password)) classes += 1;
  if (/\d/u.test(password)) classes += 1;
  // « symbole » = tout ce qui n'est ni lettre ni chiffre — large mais
  // suffisant pour la jauge (l'utilisateur voit la barre monter dès qu'il
  // ajoute un `!` ou un `_`).
  if (/[^a-zA-Z0-9]/u.test(password)) classes += 1;

  if (password.length >= 12 && classes >= 3) return 'strong';
  if (password.length >= 8 && classes >= 2) return 'medium';
  return 'weak';
}
