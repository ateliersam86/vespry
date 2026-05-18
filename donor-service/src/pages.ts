/**
 * Pages HTML servies par le Worker après un don Stripe.
 *
 * La popup de paiement est rouverte sur ces pages par Stripe (`success_url` /
 * `cancel_url`). Elles préviennent l'overlay Vespry par `postMessage`, puis se
 * referment seules. Aux couleurs crépuscule de Vespry.
 *
 * La langue vient du navigateur (`Accept-Language`) — voir `i18n.ts`.
 */
import { pickLocale, strings, type Locale } from './i18n';

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function shell(locale: Locale, title: string, inner: string, script: string): string {
  return `<!doctype html>
<html lang="${escapeAttr(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeAttr(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background:
      radial-gradient(60% 50% at 24% 18%, rgba(108,92,224,.45), transparent 72%),
      radial-gradient(55% 48% at 80% 84%, rgba(236,106,147,.32), transparent 72%),
      #130f1f;
    color: #e7e3f2;
  }
  .card {
    text-align: center; padding: 46px 40px; max-width: 380px;
    animation: in .5s cubic-bezier(.16,1,.3,1) both;
  }
  .glyph { font-size: 54px; }
  .beat { animation: beat 1.4s ease-in-out infinite; }
  h1 { font-size: 25px; margin: 14px 0 8px; font-weight: 800; }
  p { font-size: 14px; color: #9991b3; line-height: 1.55; }
  @keyframes beat { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }
  @keyframes in {
    from { opacity: 0; transform: translateY(12px) scale(.96); }
    to   { opacity: 1; transform: none; }
  }
</style>
</head>
<body>
  <div class="card">${inner}</div>
  <script>${script}</script>
</body>
</html>`;
}

/** Échappe le contenu texte d'un nœud HTML (pas pour les attributs). */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Page de retour après un don réussi, traduite selon `Accept-Language`. */
export function successPage(req: Request): string {
  const locale = pickLocale(req.headers.get('Accept-Language'));
  const s = strings(locale);
  return shell(
    locale,
    s.successTitle,
    `<div class="glyph beat">💜</div>
     <h1>${escapeText(s.successHeading)}</h1>
     <p>${escapeText(s.successBody)}</p>`,
    `try { if (window.opener) window.opener.postMessage('vespry-donation-ok', '*'); } catch (e) {}
     setTimeout(function () { window.close(); }, 2800);`,
  );
}

/** Page de retour après un don annulé, traduite selon `Accept-Language`. */
export function cancelPage(req: Request): string {
  const locale = pickLocale(req.headers.get('Accept-Language'));
  const s = strings(locale);
  return shell(
    locale,
    s.cancelTitle,
    `<div class="glyph">🌙</div>
     <h1>${escapeText(s.cancelHeading)}</h1>
     <p>${escapeText(s.cancelBody)}</p>`,
    `try { if (window.opener) window.opener.postMessage('vespry-donation-cancel', '*'); } catch (e) {}
     setTimeout(function () { window.close(); }, 2400);`,
  );
}
