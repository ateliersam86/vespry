/**
 * ErrorBoundary Vespry — filet de sécurité pour les crashs Preact.
 *
 * Sans boundary, une exception qui remonte d'un composant casse l'arbre :
 * l'overlay devient un écran blanc, l'utilisateur n'a aucun moyen de
 * signaler l'incident. Ce composant attrape l'erreur, l'envoie dans le
 * buffer de diagnostic (`recordEvent`) et propose un fallback minimaliste
 * avec deux issues : signaler le problème ou retenter le rendu.
 *
 * Convention de placement : enrober les RACINES de chaque vue (overlay
 * monté en Shadow DOM, popup) — pas chaque petit composant interne, sous
 * peine d'avaler des erreurs qui devraient remonter. La granularité
 * « par vue » garde le diagnostic clair (contexte = "overlay" ou
 * "popup").
 *
 * Préfixé d'un 🦊 — animal totem Vespry, déjà présent côté hibou dans
 * l'overlay (`OwlMark`).
 */
import { Component, type ComponentChildren } from 'preact';
import { recordEvent, reportProblem } from '../diagnostics';

interface ErrorBoundaryProps {
  /** Étiquette du contexte courant — apparaît dans `recordEvent`. */
  context: string;
  children: ComponentChildren;
}

interface ErrorBoundaryState {
  /** Vrai après un `componentDidCatch` — déclenche le fallback. */
  crashed: boolean;
  /** Message court de l'erreur — affiché dans le rapport pré-rempli. */
  summary: string;
}

/**
 * Boundary classe — pattern Preact / React. `getDerivedStateFromError`
 * positionne le drapeau au prochain rendu (sans side-effect), et
 * `componentDidCatch` consigne l'erreur (avec stack) dans le buffer
 * diagnostic. Les deux hooks sont nécessaires : seul `getDerived…`
 * garantit que le fallback s'affiche dès le rendu fautif.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { crashed: false, summary: '' };

  /** Cohérence Preact : bascule l'état dès qu'une erreur est levée en rendu. */
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { crashed: true, summary: error.message || 'Erreur inconnue' };
  }

  /**
   * Consigne l'erreur dans le buffer de diagnostic (60 dernières lignes,
   * cf. `diagnostics.ts`). On embarque la stack quand elle est dispo —
   * c'est ce qui fait la différence dans un rapport GitHub.
   */
  componentDidCatch(error: Error, errorInfo: { componentStack?: string }): void {
    const stack = error.stack ?? errorInfo.componentStack ?? '(stack indisponible)';
    recordEvent(
      'error',
      `ErrorBoundary [${this.props.context}]: ${error.message}\n${stack}`,
    );
  }

  /** Bouton primaire : ouvre l'issue GitHub pré-remplie avec le résumé. */
  private handleReport = (): void => {
    void reportProblem(this.state.summary);
  };

  /** Bouton secondaire : retente le rendu après un fix éventuel côté state. */
  private handleRetry = (): void => {
    this.setState({ crashed: false, summary: '' });
  };

  render(): ComponentChildren {
    if (!this.state.crashed) return this.props.children;

    // Fallback inline (pas de CSS externe — l'overlay vit dans un Shadow DOM
    // qui peut ne pas avoir chargé `overlay.css` au moment du crash, et le
    // popup pourrait crasher avant son propre stylesheet).
    return (
      <div
        role="alert"
        style={{
          fontFamily: '"gg sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
          background: '#221d2e',
          color: '#e7e3f2',
          border: '1px solid #352e44',
          borderRadius: '8px',
          padding: '20px 22px',
          margin: '16px',
          maxWidth: '420px',
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px' }}>
          🦊 Oups, Vespry a rencontré un souci.
        </div>
        <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#9991b3' }}>
          L'erreur a été enregistrée. Tu peux la signaler pour qu'on la corrige.
        </p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={this.handleReport}
            style={{
              appearance: 'none',
              border: 'none',
              borderRadius: '8px',
              background: '#6c5ce0',
              color: '#fff',
              fontWeight: 600,
              padding: '9px 14px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Signaler ce problème
          </button>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{
              appearance: 'none',
              borderRadius: '8px',
              background: 'transparent',
              color: '#e7e3f2',
              border: '1px solid #352e44',
              fontWeight: 600,
              padding: '9px 14px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Réessayer
          </button>
        </div>
      </div>
    );
  }
}
