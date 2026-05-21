/**
 * Tutoriel interactif au premier lancement de Vespry.
 *
 * Trois étapes : (1) colonne serveurs/salons à gauche, (2) panneau de
 * réglages à droite, (3) bouton Lancer en bas. Spotlight sur l'élément
 * ciblé via box-shadow géante simulant un trou dans un backdrop sombre.
 *
 * Trigger : flag `vespry.tutoCompleted` dans `chrome.storage.local`.
 * Si absent ou faux, le tuto se lance automatiquement à l'ouverture de
 * l'overlay. Bouton « Passer » permet de fermer définitivement, bouton
 * « Revoir » accessible depuis le popup.
 *
 * Animations CSS pures (opacity + translateY), pas de lib externe.
 * Recalcule la position cible toutes les ~150ms pour suivre les éventuels
 * resizes de l'overlay pendant le tour.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { t } from '../../ui/i18n';

interface Step {
  /** Sélecteur CSS de l'élément à mettre en lumière (cherché dans le shadow root). */
  selector: string;
  /** Clé i18n du titre court. */
  titleKey: string;
  /** Clé i18n du contenu (1-2 phrases). */
  bodyKey: string;
  /** Position de la bulle relative au spotlight. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

const STEPS: Step[] = [
  {
    selector: '.v-rail',
    titleKey: 'tuto.step1_title',
    bodyKey: 'tuto.step1_body',
    placement: 'right',
  },
  {
    selector: '.v-side',
    titleKey: 'tuto.step2_title',
    bodyKey: 'tuto.step2_body',
    placement: 'left',
  },
  {
    selector: '.v-tuto-launch',
    titleKey: 'tuto.step3_title',
    bodyKey: 'tuto.step3_body',
    placement: 'top',
  },
];

const STORAGE_KEY = 'vespry.tutoCompleted';

interface Props {
  /**
   * Racine où chercher les éléments cibles (l'overlay vit dans un Shadow
   * DOM — `document.querySelector` ne le trouve pas).
   */
  root: ShadowRoot | Document;
  /** Appelé quand le tuto se termine (skip ou fin normale). */
  onClose: () => void;
}

interface Rect { top: number; left: number; width: number; height: number }

/**
 * Mesure la position d'un élément relative à la fenêtre (viewport).
 * Renvoie null si l'élément n'existe pas (rendu différé).
 */
function measure(root: ShadowRoot | Document, selector: string): Rect | null {
  const el = root.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function Tutorial({ root, onClose }: Props): JSX.Element | null {
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const rafRef = useRef<number | null>(null);

  // Suit l'élément cible : remesure à chaque frame tant que le tuto est ouvert.
  // Coûte peu (rAF) et garantit que le spotlight reste collé même si l'overlay
  // se redimensionne ou scrolle.
  useEffect(() => {
    function tick(): void {
      const r = measure(root, STEPS[stepIdx]!.selector);
      setRect(r);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [root, stepIdx]);

  // Escape ferme le tuto sans le marquer comme « complété » (l'utilisateur
  // pourra le rappeler depuis le popup). Skip explicite le marque complété.
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

  function skip(): void {
    void chrome.storage.local.set({ [STORAGE_KEY]: true });
    onClose();
  }

  function next(): void {
    if (stepIdx < STEPS.length - 1) {
      setStepIdx(stepIdx + 1);
    } else {
      skip();
    }
  }

  function prev(): void {
    if (stepIdx > 0) setStepIdx(stepIdx - 1);
  }

  const step = STEPS[stepIdx]!;
  // Si la cible n'est pas trouvée (vue pas encore prête), on rend quand même
  // la bulle centrée à l'écran pour ne pas bloquer. Cas dégradé.
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
          immense qui crée le voile autour). */}
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
          <button class="v-btn v-btn-ghost" onClick={skip}>
            {t('tuto.skip')}
          </button>
          <div class="v-tuto-nav">
            {stepIdx > 0 && (
              <button class="v-btn v-btn-ghost" onClick={prev}>
                {t('tuto.prev')}
              </button>
            )}
            <button class="v-btn" onClick={next}>
              {stepIdx === STEPS.length - 1 ? t('tuto.done') : t('tuto.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Vérifie si le tuto doit s'afficher (flag absent ou false).
 * Utilisé par Overlay au montage.
 */
export async function shouldShowTutorial(): Promise<boolean> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] !== true;
}

/** Force le tuto à se relancer (depuis le popup, bouton « Revoir le tuto »). */
export async function resetTutorial(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: false });
}

/** Calcule la position de la bulle selon le placement choisi. */
function bubblePosition(spot: Rect, placement: 'top' | 'bottom' | 'left' | 'right'): string {
  const margin = 16;
  switch (placement) {
    case 'right':
      return `top:${spot.top}px;left:${spot.left + spot.width + margin}px;`
        + 'transform:translate(0,0);';
    case 'left':
      return `top:${spot.top}px;left:${spot.left - margin}px;`
        + 'transform:translate(-100%,0);';
    case 'bottom':
      return `top:${spot.top + spot.height + margin}px;left:${spot.left + spot.width / 2}px;`
        + 'transform:translate(-50%,0);';
    case 'top':
    default:
      return `top:${spot.top - margin}px;left:${spot.left + spot.width / 2}px;`
        + 'transform:translate(-50%,-100%);';
  }
}

/** Position centrée (cas dégradé quand la cible n'est pas trouvée). */
function centerStyle(): string {
  return 'top:50%;left:50%;transform:translate(-50%,-50%);';
}
