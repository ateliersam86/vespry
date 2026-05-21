/**
 * Pastille « ? » d'aide contextuelle.
 *
 * Rendue inline à droite du label qu'elle accompagne. Hover ou focus
 * révèle une bulle au-dessus avec un texte court (max 2 phrases). Esc ou
 * blur ferme la bulle. Accessible au clavier (Tab), `aria-describedby`
 * pointant vers le contenu de la bulle.
 *
 * Design : 16px de diamètre, fond `--bg3`, bordure `--border`, le « ? »
 * en `--muted`. Au focus/hover, accent violet. La bulle est positionnée
 * en absolute au-dessus de la pastille, max 280px de large.
 *
 * Usage :
 *   <label>Chiffrement <HelpTip id="enc" text="AES-256 chiffre le zip..." /></label>
 *
 * Pas d'animation Framer ni de lib externe : transitions CSS pures
 * (opacity + translateY) pour garder le bundle léger.
 */
import { useId, useState, useRef, useEffect } from 'preact/hooks';
import type { JSX } from 'preact';

interface Props {
  /** Identifiant logique du tooltip, pour stable `aria-describedby`. */
  id?: string;
  /** Texte de la bulle. Court de préférence (1-2 phrases). */
  text: string;
  /** Position de la bulle. `top` (défaut) place au-dessus de la pastille. */
  placement?: 'top' | 'bottom' | 'right';
}

export function HelpTip({ id, text, placement = 'top' }: Props): JSX.Element {
  // useId génère un id stable (Preact 10.20+) ; fallback sur prop ou random.
  const reactId = useId();
  const tipId = id ?? `vht-${reactId.replace(/[^\w-]/g, '')}`;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Fermeture sur Escape.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.blur();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span class={`v-help-tip v-help-tip--${placement}`}>
      <button
        ref={btnRef}
        type="button"
        class="v-help-tip-btn"
        aria-label="Aide"
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          // Click toggle : permet de garder la bulle ouverte sur mobile/touch.
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          // Gérer Escape ici directement : si on `stopPropagation` aveuglément,
          // le listener `window` qui ferme la bulle ne reçoit jamais l'event.
          // Cf. audit Codex 2026-05-22 #7. Pour les autres touches, on stoppe
          // la propagation pour éviter que Discord intercepte (raccourcis `/`).
          if (e.key === 'Escape') {
            setOpen(false);
            btnRef.current?.blur();
            return;
          }
          e.stopPropagation();
        }}
      >
        ?
      </button>
      <span
        id={tipId}
        role="tooltip"
        class={`v-help-tip-bubble ${open ? 'open' : ''}`}
      >
        {text}
      </span>
    </span>
  );
}
