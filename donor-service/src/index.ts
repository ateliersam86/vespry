/**
 * vespry-donors — Worker du mur des soutiens.
 *
 * Routes :
 *   GET  /donors           → flux public (DonorFeed), CORS ouvert, cache 60 s.
 *   POST /checkout         → crée une session Stripe Checkout → { url }.
 *   POST /stripe/webhook   → ingestion Stripe (auth : signature HMAC).
 *   GET  /checkout/success → page de retour (don réussi).
 *   GET  /checkout/cancel  → page de retour (don annulé).
 *   POST /kofi/webhook     → ingestion Ko-Fi (auth : verification_token).
 *   POST /github/webhook   → ingestion GitHub Sponsors (auth : HMAC-SHA256).
 *   GET  /admin/list       → liste complète, masqués inclus (auth : ADMIN_SECRET).
 *   POST /admin/hide       → masque une entrée { seq } (auth : ADMIN_SECRET).
 *
 * Aucune donnée nominative n'est exposée sans le consentement du donateur
 * (`is_public`). Les montants ne sont jamais stockés ni renvoyés.
 */
import { getFeed, hideDonor, insertDonor, listAll } from './donors';
import { parseGithub, verifyGithubSignature } from './github';
import { parseKofi } from './kofi';
import { cleanText, MAX_MESSAGE, MAX_NAME } from './moderation';
import { cancelPage, successPage } from './pages';
import {
  createCheckoutSession,
  parseStripeEvent,
  validAmount,
  verifyStripeSignature,
} from './stripe';

export interface Env {
  DB: D1Database;
  /** Jeton fourni par Ko-Fi (réglages Webhooks). */
  KOFI_VERIFICATION_TOKEN: string;
  /** Secret partagé du webhook GitHub Sponsors. */
  GITHUB_WEBHOOK_SECRET: string;
  /** Jeton d'administration (masquage manuel d'entrées). */
  ADMIN_SECRET: string;
  /** Clé secrète Stripe (`sk_live_…`). */
  STRIPE_SECRET_KEY: string;
  /** Secret de signature du webhook Stripe (`whsec_…`). */
  STRIPE_WEBHOOK_SECRET: string;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

/** Ingestion d'un don Ko-Fi. */
async function handleKofi(req: Request, env: Env): Promise<Response> {
  const payload = parseKofi(await req.text());
  if (!payload) return json({ error: 'bad payload' }, 400);
  if (
    !env.KOFI_VERIFICATION_TOKEN
    || payload.verificationToken !== env.KOFI_VERIFICATION_TOKEN
  ) {
    return json({ error: 'unauthorized' }, 401);
  }
  // Abonnement déjà en cours : ne compter QUE le premier paiement, pas les
  // renouvellements mensuels (sinon le même soutien réapparaît chaque mois).
  if (payload.isSubscriptionPayment && !payload.isFirstSubscriptionPayment) {
    return json({ ok: true, skipped: 'recurring' });
  }
  await insertDonor(env.DB, {
    source: 'kofi',
    externalId: `kofi:${payload.messageId}`,
    name: payload.isPublic ? cleanText(payload.fromName, MAX_NAME) : null,
    message: payload.isPublic ? cleanText(payload.message, MAX_MESSAGE) : null,
    isPublic: payload.isPublic,
    createdAt: Date.parse(payload.timestamp) || Date.now(),
  });
  return json({ ok: true });
}

/** Ingestion d'un nouveau parrainage GitHub Sponsors. */
async function handleGithub(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  const signature = req.headers.get('X-Hub-Signature-256') ?? '';
  if (!(await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
    return json({ error: 'bad signature' }, 401);
  }
  const sponsorship = parseGithub(body);
  // Événement non pertinent (changement de palier, annulation…) : 200 quand même.
  if (!sponsorship) return json({ ok: true, skipped: 'event' });
  await insertDonor(env.DB, {
    source: 'github',
    externalId: `github:${sponsorship.login}:${sponsorship.createdAt}`,
    name: sponsorship.isPublic
      ? cleanText(sponsorship.name ?? sponsorship.login, MAX_NAME)
      : null,
    // GitHub Sponsors ne transmet pas de message public.
    message: null,
    isPublic: sponsorship.isPublic,
    createdAt: sponsorship.createdAt,
  });
  return json({ ok: true });
}

/** Crée une session de paiement Stripe Checkout pour un don. */
async function handleCheckout(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'stripe not configured' }, 503);
  }
  const parsed = (await req.json().catch(() => null)) as {
    amountCents?: unknown;
    donorName?: unknown;
    message?: unknown;
    isPublic?: unknown;
  } | null;
  if (!parsed || !validAmount(parsed.amountCents)) {
    return json({ error: 'invalid amount' }, 400);
  }
  const isPublic = parsed.isPublic === true;
  const url = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
    amountCents: parsed.amountCents,
    // Coupé en longueur ici ; le filtre de modération s'applique au webhook.
    donorName:
      isPublic && typeof parsed.donorName === 'string'
        ? parsed.donorName.trim().slice(0, MAX_NAME)
        : null,
    message:
      isPublic && typeof parsed.message === 'string'
        ? parsed.message.trim().slice(0, MAX_MESSAGE)
        : null,
    isPublic,
    origin: new URL(req.url).origin,
  });
  if (!url) return json({ error: 'stripe error' }, 502);
  return json({ url });
}

/** Ingestion d'un don Stripe confirmé (`checkout.session.completed`). */
async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  const signature = req.headers.get('Stripe-Signature') ?? '';
  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, body, signature))) {
    return json({ error: 'bad signature' }, 401);
  }
  const event = parseStripeEvent(body);
  if (!event) return json({ ok: true, skipped: 'event' });
  if (!event.paid) return json({ ok: true, skipped: 'unpaid' });
  await insertDonor(env.DB, {
    source: 'stripe',
    externalId: `stripe:${event.sessionId}`,
    name: event.isPublic ? cleanText(event.donorName, MAX_NAME) : null,
    message: event.isPublic ? cleanText(event.message, MAX_MESSAGE) : null,
    isPublic: event.isPublic,
    createdAt: Date.now(),
  });
  return json({ ok: true });
}

/** Endpoints d'administration — protégés par ADMIN_SECRET. */
async function handleAdmin(
  req: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  if (
    !env.ADMIN_SECRET
    || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_SECRET}`
  ) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (req.method === 'GET' && pathname === '/admin/list') {
    return json(await listAll(env.DB));
  }
  if (req.method === 'POST' && pathname === '/admin/hide') {
    const parsed = (await req.json().catch(() => null)) as { seq?: unknown } | null;
    if (!parsed || typeof parsed.seq !== 'number') {
      return json({ error: 'seq (number) required' }, 400);
    }
    await hideDonor(env.DB, parsed.seq);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const { pathname } = new URL(req.url);

    if (req.method === 'GET' && pathname === '/donors') {
      return json(await getFeed(env.DB), 200, {
        'Cache-Control': 'public, max-age=60',
      });
    }
    if (req.method === 'POST' && pathname === '/kofi/webhook') {
      return handleKofi(req, env);
    }
    if (req.method === 'POST' && pathname === '/github/webhook') {
      return handleGithub(req, env);
    }
    if (req.method === 'POST' && pathname === '/checkout') {
      return handleCheckout(req, env);
    }
    if (req.method === 'POST' && pathname === '/stripe/webhook') {
      return handleStripeWebhook(req, env);
    }
    if (req.method === 'GET' && pathname === '/checkout/success') {
      return new Response(successPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (req.method === 'GET' && pathname === '/checkout/cancel') {
      return new Response(cancelPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (pathname.startsWith('/admin/')) {
      return handleAdmin(req, env, pathname);
    }
    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
