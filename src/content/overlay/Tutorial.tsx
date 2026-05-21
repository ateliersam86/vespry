/**
 * Tutoriel interactif Vespry.
 *
 * Monté dans son propre host DOM (cf. `mount-tutorial.tsx`), JAMAIS dans
 * le shadow DOM de l'overlay Vespry — parce qu'un parent de cet overlay a
 * `filter: blur(...)` qui crée un containing block et casse position:fixed
 * (le backdrop n'aurait pas couvert le viewport). Cf. feedback Sam
 * 2026-05-21 : « les overlays de tutoriel sont totalement buggés,
 * transparents et horribles ».
 *
 * Quatre étapes :
 *   0. Bouton lanceur Vespry (cible dans le DOM principal Discord)
 *   1. Colonne serveurs/salons (cible dans le shadow Vespry)
 *   2. Panneau de réglages à droite (cible dans le shadow Vespry)
 *   3. Bouton « Lancer l'export » (cible dans le shadow Vespry)
 *
 * Le step 0 est visible AVANT que l'overlay Vespry soit ouvert. Quand
 * l'utilisateur clique sur le bouton lanceur, l'overlay s'ouvre et les
 * steps 1-3 enchaînent automatiquement (le tuto détecte l'apparition du
 * shadow root et avance).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { t } from '../../ui/i18n';

interface Step {
  /** Sélecteur CSS de l'élément à mettre en lumière. */
  selector: string;
  /**
   * Où chercher le sélecteur : `'doc'` (DOM principal Discord) pour le
   * bouton lanceur ; `'shadow'` (shadow root Vespry, host id
   * `vespry-overlay-host`) pour les éléments de l'overlay.
   */
  scope: 'doc' | 'shadow';
  /** Clé i18n du titre court. */
  titleKey: string;
  /** Clé i18n du contenu (1-2 phrases). */
  bodyKey: string;
  /** Position de la bulle relative au spotlight. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

const STEPS: Step[] = [
  {
    selector: '#vespry-launch-btn',
    scope: 'doc',
    titleKey: 'tuto.step0_title',
    bodyKey: 'tuto.step0_body',
    placement: 'bottom',
  },
  {
    selector: '.v-rail',
    scope: 'shadow',
    titleKey: 'tuto.step1_title',
    bodyKey: 'tuto.step1_body',
    placement: 'right',
  },
  {
    selector: '.v-side',
    scope: 'shadow',
    titleKey: 'tuto.step2_title',
    bodyKey: 'tuto.step2_body',
    placement: 'left',
  },
  {
    selector: '.v-tuto-launch',
    scope: 'shadow',
    titleKey: 'tuto.step3_title',
    bodyKey: 'tuto.step3_body',
    placement: 'top',
  },
];

const STORAGE_KEY = 'vespry.tutoCompleted';
const FIRST_SEEN_KEY = 'vespry.firstSeenOnDiscord';

interface Props {
  /**
   * Index de départ. 0 = démarre par le bouton lanceur (premier launch
   * ou bouton « Revoir »). 1+ = utilisé en interne quand on enchaîne.
   */
  startStep?: number;
  /** Appelé quand le tuto se termine (skip ou fin normale). */
  onClose: () => void;
}

interface Rect { top: number; left: number; width: number; height: number }

/**
 * Mesure la position d'un élément relative à la fenêtre. Cherche dans
 * `document` ou dans le shadow root Vespry selon `scope`. Renvoie null
 * si l'élément n'existe pas (rendu différé, vue pas encore montée).
 */
function measure(scope: 'doc' | 'shadow', selector: string): Rect | null {
  let root: Document | ShadowRoot | null = document;
  if (scope === 'shadow') {
    const host = document.getElementById('vespry-overlay-host');
    root = host?.shadowRoot ?? null;
  }
  if (!root) return null;
  const el = root.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function Tutorial({ startStep = 0, onClose }: Props): JSX.Element | null {
  const [stepIdx, setStepIdx] = useState(startStep);
  const [rect, setRect] = useState<Rect | null>(null);
  const rafRef = useRef<number | null>(null);

  // Suit l'élément cible à chaque frame. Si on est sur le step 0 (bouton
  // lanceur) et que l'utilisateur clique dessus, l'overlay Vespry va se
  // monter — on détecte la présence du shadow root et on passe au step 1.
  useEffect(() => {
    function tick(): void {
      const step = STEPS[stepIdx]!;
      const r = measure(step.scope, step.selector);
      setRect(r);

      // Avancement automatique step 0 → 1 quand l'overlay Vespry apparaît.
      if (stepIdx === 0) {
        const host = document.getElementById('vespry-overlay-host');
        if (host?.shadowRoot?.querySelector('.v-rail')) {
          setStepIdx(1);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [stepIdx]);

  // Escape ferme le tuto sans le marquer complété.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  function markComplete(): void {
    void chrome.storage.local.set({
      [STORAGE_KEY]: true,
      [FIRST_SEEN_KEY]: true,
    });
  }

  function skip(): void {
    markComplete();
    onClose();
  }

  function next(): void {
    if (stepIdx < STEPS.length - 1) {
      setStepIdx(stepIdx + 1);
    } else {
      markComplete();
      onClose();
    }
  }

  function prev(): void {
    if (stepIdx > 0) setStepIdx(stepIdx - 1);
  }

  const step = STEPS[stepIdx]!;
  const padding = 8;
  const spotlight = rect
    ? {
        top: rect.top - padding,
        left: rect.left - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
      }
    : null;

  const placement = step.placement ?? 'top';
  const bubbleStyle = spotlight ? bubblePosition(spotlight, placement) : centerStyle();

  return (
    <div class="v-tuto-root" role="dialog" aria-label={t('tuto.dialog_label')}>
      {/* Backdrop sombre + spotlight via box-shadow géante (technique
          classique : la « fenêtre » a un fond transparent et une box-shadow
          immense qui crée le voile autour). Pendant que la cible est
          introuvable on affiche un backdrop plein (cas dégradé). */}
      {spotlight ? (
        <div
          class="v-tuto-spotlight"
          style={`top:${spotlight.top}px;left:${spotlight.left}px;`
            + `width:${spotlight.width}px;height:${spotlight.height}px;`}
        />
      ) : (
        <div class="v-tuto-backdrop" />
      )}
      <div class="v-tuto-bubble" style={bubbleStyle}>
        <div class="v-tuto-step">
          {t('tuto.step_n', { n: stepIdx + 1, total: STEPS.length })}
        </div>
        <div class="v-tuto-title">{t(step.titleKey)}</div>
        <div class="v-tuto-body">{t(step.bodyKey)}</div>
        <div class="v-tuto-actions">
          <button class="v-tuto-btn v-tuto-btn-ghost" onClick={skip}>
            {t('tuto.skip')}
          </button>
          <div class="v-tuto-nav">
            {stepIdx > 0 && (
              <button class="v-tuto-btn v-tuto-btn-ghost" onClick={prev}>
                {t('tuto.prev')}
              </button>
            )}
            <button class="v-tuto-btn v-tuto-btn-primary" onClick={next}>
              {stepIdx === STEPS.length - 1 ? t('tuto.done') : t('tuto.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Vérifie si le tuto doit s'afficher automatiquement au premier launch.
 * True si jamais vu sur Discord (`firstSeenOnDiscord` absent).
 */
export async function shouldShowTutorial(): Promise<boolean> {
  const r = await chrome.storage.local.get([STORAGE_KEY, FIRST_SEEN_KEY]);
  return r[FIRST_SEEN_KEY] !== true && r[STORAGE_KEY] !== true;
}

/** Force le tuto à se relancer (depuis le popup, bouton « Revoir »). */
export async function resetTutorial(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: false, [FIRST_SEEN_KEY]: false });
}

/**
 * Calcule la position de la bulle selon le placement choisi, en clampant
 * dans le viewport. La bulle fait ~320 × ~180 px (cf. Tutorial.css), et
 * on garde un margin de sécurité de 16 px par rapport aux bords. Si le
 * placement souhaité fait dépasser la bulle, on bascule sur l'aligne
 * opposé (translate négatif au lieu de positif, ou centrage au bord).
 *
 * Cf. feedback Sam 2026-05-21 : « l'étape 1 du tutoriel est complètement
 * coupée, elle dépasse totalement hors du viewport » — typique du
 * bouton lanceur en haut à droite avec `placement: 'bottom'`.
 */
const BUBBLE_W = 320;
const BUBBLE_H = 180;
const SAFE = 16;

function bubblePosition(spot: Rect, placement: 'top' | 'bottom' | 'left' | 'right'): string {
  const margin = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Helper : à partir d'une position "naïve" (centre cible), renvoie un
  // `(left, transform)` qui garantit que la bulle reste dans le viewport.
  // `cx` = x du centre désiré, sans clamp.
  function clampX(cx: number): { left: number; tx: string } {
    const halfW = BUBBLE_W / 2;
    if (cx - halfW < SAFE) {
      // Trop à gauche → on aligne le bord gauche de la bulle au SAFE.
      return { left: SAFE, tx: '0%' };
    }
    if (cx + halfW > vw - SAFE) {
      // Trop à droite → on aligne le bord droit de la bulle à vw - SAFE.
      return { left: vw - SAFE, tx: '-100%' };
    }
    return { left: cx, tx: '-50%' };
  }
  function clampY(cy: number): { top: number; ty: string } {
    const halfH = BUBBLE_H / 2;
    if (cy - halfH < SAFE) {
      return { top: SAFE, ty: '0%' };
    }
    if (cy + halfH > vh - SAFE) {
      return { top: vh - SAFE, ty: '-100%' };
    }
    return { top: cy, ty: '-50%' };
  }

  switch (placement) {
    case 'right': {
      const left = spot.left + spot.width + margin;
      const fitsRight = left + BUBBLE_W + SAFE <= vw;
      if (fitsRight) {
        const y = clampY(spot.top + spot.height / 2);
        return `top:${y.top}px;left:${left}px;transform:translate(0,${y.ty});`;
      }
      // Pas la place à droite → fallback en bottom centré.
      const top = Math.min(spot.top + spot.height + margin, vh - BUBBLE_H - SAFE);
      const x = clampX(spot.left + spot.width / 2);
      return `top:${top}px;left:${x.left}px;transform:translate(${x.tx},0);`;
    }
    case 'left': {
      const right = spot.left - margin;
      const fitsLeft = right - BUBBLE_W - SAFE >= 0;
      if (fitsLeft) {
        const y = clampY(spot.top + spot.height / 2);
        return `top:${y.top}px;left:${right}px;transform:translate(-100%,${y.ty});`;
      }
      // Pas la place à gauche → fallback en bottom centré.
      const top = Math.min(spot.top + spot.height + margin, vh - BUBBLE_H - SAFE);
      const x = clampX(spot.left + spot.width / 2);
      return `top:${top}px;left:${x.left}px;transform:translate(${x.tx},0);`;
    }
    case 'bottom': {
      const top = spot.top + spot.height + margin;
      const fitsBottom = top + BUBBLE_H + SAFE <= vh;
      const y = fitsBottom ? top : Math.max(SAFE, spot.top - margin - BUBBLE_H);
      const x = clampX(spot.left + spot.width / 2);
      const ty = fitsBottom ? '0' : '0'; // toujours aligné top de la bulle au y calculé
      return `top:${y}px;left:${x.left}px;transform:translate(${x.tx},${ty});`;
    }
    case 'top':
    default: {
      const above = spot.top - margin;
      const fitsTop = above - BUBBLE_H - SAFE >= 0;
      if (fitsTop) {
        const x = clampX(spot.left + spot.width / 2);
        return `top:${above}px;left:${x.left}px;transform:translate(${x.tx},-100%);`;
      }
      // Pas la place au-dessus → bascule en bottom.
      const top = Math.min(spot.top + spot.height + margin, vh - BUBBLE_H - SAFE);
      const x = clampX(spot.left + spot.width / 2);
      return `top:${top}px;left:${x.left}px;transform:translate(${x.tx},0);`;
    }
  }
}

/** Position centrée (cas dégradé quand la cible n'est pas trouvée). */
function centerStyle(): string {
  return 'top:50%;left:50%;transform:translate(-50%,-50%);';
}
