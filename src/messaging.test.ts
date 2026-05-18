/**
 * Tests du helper `progressPct` — calcul du pourcentage d'avancement.
 *
 * Cas couverts : préférence messages/estimated, fallback channels,
 * division par zéro, clamp 100 %, valeurs `null` pour estimatedMessages.
 *
 * Couverture importante car `progressPct` est utilisé partout (overlay,
 * popup, badge icône, label du bouton lanceur) — un bug ici se voit
 * immédiatement sur 4 surfaces UX.
 */
import { describe, expect, it } from 'vitest';
import { progressPct } from './messaging';

describe('progressPct', () => {
  it('utilise messages/estimatedMessages quand l\'estimation est dispo', () => {
    expect(progressPct({
      channelsTotal: 10, channelsDone: 1,
      messages: 500, estimatedMessages: 1000,
    })).toBe(50);
  });

  it('retombe sur channelsDone/channelsTotal quand estimatedMessages est null', () => {
    expect(progressPct({
      channelsTotal: 5, channelsDone: 2,
      messages: 9999, estimatedMessages: null,
    })).toBe(40);
  });

  it('retombe sur channels quand estimatedMessages vaut 0 (échec de pré-comptage)', () => {
    // Cas réel : API search retourne 0 partout (perms refusées sur tous
    // les salons). On ne veut pas afficher 100 % d'office, on retombe.
    expect(progressPct({
      channelsTotal: 4, channelsDone: 1,
      messages: 100, estimatedMessages: 0,
    })).toBe(25);
  });

  it('clamp à 100 quand on dépasse l\'estimation (Discord plafonne à 8000/salon)', () => {
    // L'API search Discord renvoie max 8000 ; si le salon en a vraiment
    // 12 000, on télécharge plus que l'estimation. Le ratio dépasse 1,
    // mais l'UI ne doit pas montrer 130 %.
    expect(progressPct({
      channelsTotal: 1, channelsDone: 0,
      messages: 12_000, estimatedMessages: 8_000,
    })).toBe(100);
  });

  it('retourne 0 quand rien n\'est commencé', () => {
    expect(progressPct({
      channelsTotal: 0, channelsDone: 0,
      messages: 0, estimatedMessages: null,
    })).toBe(0);
  });

  it('retourne 0 même quand channelsTotal === 0 et estimatedMessages === 0', () => {
    // État initial juste après la création du run, AVANT que le pré-comptage
    // ait écrit estimatedMessages. Pas de division par zéro.
    expect(progressPct({
      channelsTotal: 0, channelsDone: 0,
      messages: 0, estimatedMessages: 0,
    })).toBe(0);
  });

  it('reste cohérent à la transition estimation null → valeur arrivée', () => {
    const before = progressPct({
      channelsTotal: 3, channelsDone: 1,
      messages: 100, estimatedMessages: null,
    });
    const after = progressPct({
      channelsTotal: 3, channelsDone: 1,
      messages: 100, estimatedMessages: 1000,
    });
    // Avant : 33 % (1/3 salons). Après : 10 % (100/1000). C'est ATTENDU :
    // l'estimation messages est plus juste — la barre peut « revenir »
    // une fois au démarrage. Documenté comme tradeoff.
    expect(before).toBe(33);
    expect(after).toBe(10);
  });

  it('arrondit à l\'entier le plus proche', () => {
    expect(progressPct({
      channelsTotal: 3, channelsDone: 1,
      messages: 1, estimatedMessages: 7,
    })).toBe(14); // 1/7 = 14.285…
  });
});
