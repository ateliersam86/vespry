/**
 * Sentinelle de schéma — détecte les champs Discord inconnus en runtime.
 *
 * Notre code rend ce qu'il connaît ; le reste est silencieusement conservé
 * dans le JSON brut (cf. forward-compat dans types.ts). Cette sentinelle
 * ajoute une trace console quand Discord renvoie un champ qu'on n'a jamais
 * vu — sans jamais planter — pour qu'on sache QUAND mettre à jour le rendu.
 *
 * Les détections sont AUSSI mémorisées en RAM (Set) et exposées via
 * `getDetectedUnknowns()`. Le bouton « Signaler un problème » de l'overlay
 * les incorpore au pré-rempli pour qu'on n'ait pas à fouiller la console.
 *
 * On log au plus une fois par clé inconnue par session (dédup) pour ne pas
 * spammer la console sur de gros exports.
 */

/** Champs `RawMessage` que Vespry connaît et traite explicitement. */
const KNOWN_MESSAGE_FIELDS = new Set<string>([
  'id', 'type', 'channel_id', 'author', 'content', 'timestamp',
  'edited_timestamp', 'pinned', 'tts', 'flags', 'webhook_id',
  'attachments', 'embeds', 'reactions', 'mentions', 'mention_roles',
  'mention_everyone', 'message_reference', 'referenced_message',
  'sticker_items', 'thread', 'components', 'poll', 'call',
  // champs renvoyés par Discord qu'on stocke sans rien rendre dessus :
  'application_id', 'application', 'activity', 'interaction',
  'interaction_metadata', 'guild_id', 'member', 'role_subscription_data',
  'resolved', 'position', 'nonce', 'message_snapshots',
]);

const seenUnknowns = new Set<string>();

/**
 * Inspecte un message Discord brut et logge en console les noms de champs
 * qu'on ne reconnaît pas. Idempotent par clé : un même nom n'est loggé
 * qu'une seule fois par session.
 */
export function watchMessageSchema(message: unknown): void {
  if (!message || typeof message !== 'object') return;
  for (const key of Object.keys(message)) {
    if (KNOWN_MESSAGE_FIELDS.has(key)) continue;
    if (seenUnknowns.has(key)) continue;
    seenUnknowns.add(key);
    console.info(
      `[Vespry] Champ Discord inconnu rencontré : « ${key} ». `
      + 'Il est préservé dans le JSON exporté. '
      + 'Voir https://github.com/ateliersam86/vespry/issues si Vespry doit le rendre.',
    );
  }
}

/** Liste actuelle des noms de champs Discord inconnus rencontrés. */
export function getDetectedUnknowns(): string[] {
  return [...seenUnknowns].sort();
}

/** Vide le journal — utile pour les tests. */
export function resetSchemaWatch(): void {
  seenUnknowns.clear();
}
