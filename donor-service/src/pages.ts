/**
 * Pages HTML servies par le Worker après un don Stripe.
 *
 * La popup de paiement est rouverte sur ces pages par Stripe (`success_url` /
 * `cancel_url`). Elles préviennent l'overlay Vespry par `postMessage`, puis se
 * referment seules. Aux couleurs crépuscule de Vespry.
 */

function shell(title: string, inner: string, script: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
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

/** Page de retour après un don réussi. */
export function successPage(): string {
  return shell(
    'Merci — Vespry',
    `<div class="glyph beat">💜</div>
     <h1>Merci !</h1>
     <p>Ton soutien rejoint le mur de Vespry. Cette fenêtre se ferme toute seule…</p>`,
    `try { if (window.opener) window.opener.postMessage('vespry-donation-ok', '*'); } catch (e) {}
     setTimeout(function () { window.close(); }, 2800);`,
  );
}

/** Page de retour après un don annulé. */
export function cancelPage(): string {
  return shell(
    'Don annulé — Vespry',
    `<div class="glyph">🌙</div>
     <h1>Don annulé</h1>
     <p>Aucun souci, rien n'a été débité. Tu peux fermer cette fenêtre.</p>`,
    `try { if (window.opener) window.opener.postMessage('vespry-donation-cancel', '*'); } catch (e) {}
     setTimeout(function () { window.close(); }, 2400);`,
  );
}
