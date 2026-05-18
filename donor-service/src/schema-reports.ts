/**
 * Rapports de schéma — endpoint `/schema-report`.
 *
 * Reçoit un signal envoyé par l'extension (uniquement si l'utilisateur a
 * activé l'option opt-in « aider à détecter les évolutions Discord ») :
 *   { version, locale, fields[], errors[] }
 *
 * Aucun contenu de message ni jeton dans le payload — la vie privée de
 * l'utilisateur reste intacte. La signature `(version + champs triés)` sert
 * de clé d'idempotence : on n'ouvre une issue GitHub qu'une seule fois par
 * cas distinct ; sinon on incrémente juste un compteur.
 */
import { hmacSha256Hex } from './hmac';

/**
 * Payload du rapport. STRICTEMENT minimal pour respecter la vie privée :
 * - `version` : version Vespry (publique, lue dans le manifest)
 * - `locale` : langue du navigateur (anonyme)
 * - `fields` : noms de champs Discord (spec publique Discord API)
 *
 * Tout autre champ est ignoré silencieusement, et aucun contenu de message,
 * id, jeton, ou trace d'erreur ne transite jamais ici.
 */
export interface SchemaReportPayload {
  version: string;
  locale: string;
  fields: string[];
}

/** Valide la forme attendue. Tout champ supplémentaire est IGNORÉ. */
function isValidPayload(p: unknown): p is SchemaReportPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.version === 'string'
    && o.version.length < 32
    && typeof o.locale === 'string'
    && o.locale.length < 16
    && Array.isArray(o.fields)
    && o.fields.length < 100
    && o.fields.every((f) => typeof f === 'string' && f.length < 64)
  );
}

/** Garde-fou : un nom de champ Discord est en `snake_case` ASCII pur. */
function sanitizeField(s: string): string | null {
  return /^[a-z][a-z0-9_]{0,63}$/.test(s) ? s : null;
}

/** Signature stable : hash de version + champs triés. */
async function signatureOf(p: SchemaReportPayload): Promise<string> {
  const canonical = `${p.version}|${[...p.fields].sort().join(',')}`;
  return (await hmacSha256Hex('vespry-schema', canonical)).slice(0, 16);
}

interface Env {
  DB: D1Database;
  /** PAT GitHub avec scope `issues:write` sur le dépôt Vespry. */
  GITHUB_TOKEN?: string;
  /** Dépôt cible des issues, format `owner/repo`. Défaut : ateliersam86/vespry. */
  GITHUB_REPO?: string;
}

/** Crée une issue GitHub via l'API. Renvoie son URL, ou null en cas d'échec. */
async function createGithubIssue(
  env: Env,
  payload: SchemaReportPayload,
): Promise<string | null> {
  if (!env.GITHUB_TOKEN) return null;
  const repo = env.GITHUB_REPO ?? 'ateliersam86/vespry';
  const sorted = [...payload.fields].sort();
  const title = `[api-watch] Champs Discord inconnus : ${sorted.slice(0, 3).join(', ')}`
    + (sorted.length > 3 ? '…' : '');
  const body = [
    'Rapport automatique envoyé par une instance Vespry (opt-in).',
    '',
    `- **Version Vespry** : ${payload.version}`,
    `- **Locale navigateur** : ${payload.locale}`,
    '',
    '### Champs Discord rencontrés mais non rendus',
    '```',
    ...sorted,
    '```',
    '',
    'Ces champs sont préservés dans le JSON exporté (forward-compat).',
    'À investiguer si Vespry devrait les rendre dans l\'aperçu / HTML / TXT.',
  ];
  body.push(
    '',
    '_Auto-créé via `donor-service /schema-report`. Pas de contenu de messages._',
  );
  const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'vespry-schema-watch',
    },
    body: JSON.stringify({ title, body: body.join('\n'), labels: ['api-watch', 'auto'] }),
  });
  if (!r.ok) return null;
  const data = (await r.json()) as { html_url?: string };
  return data.html_url ?? null;
}

/** Crée la table si elle n'existe pas — schéma idempotent. */
async function ensureTable(db: D1Database): Promise<void> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_reports ('
    + 'signature TEXT PRIMARY KEY, version TEXT NOT NULL, locale TEXT NOT NULL,'
    + ' fields TEXT NOT NULL, issue_url TEXT, count INTEGER NOT NULL DEFAULT 1,'
    + ' created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)',
  );
}

/** Traite un POST /schema-report. */
export async function handleSchemaReport(req: Request, env: Env): Promise<Response> {
  const raw = (await req.json().catch(() => null)) as unknown;
  if (!isValidPayload(raw)) {
    return new Response(JSON.stringify({ error: 'invalid payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Garde-fou supplémentaire : on filtre chaque champ pour ne garder que
  // les noms en `snake_case` ASCII purs. Tout le reste est jeté.
  const sanitized: SchemaReportPayload = {
    version: raw.version,
    locale: raw.locale,
    fields: [...new Set(
      raw.fields.map(sanitizeField).filter((f): f is string => f !== null),
    )].sort(),
  };
  const payload = sanitized;
  if (payload.fields.length === 0) {
    return new Response(JSON.stringify({ ok: true, skipped: 'empty' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await ensureTable(env.DB);
  const sig = await signatureOf(payload);
  const now = Date.now();

  const existing = await env.DB
    .prepare('SELECT signature, issue_url FROM schema_reports WHERE signature = ?')
    .bind(sig)
    .first<{ signature: string; issue_url: string | null }>();

  if (existing) {
    await env.DB
      .prepare('UPDATE schema_reports SET count = count + 1, last_seen = ? WHERE signature = ?')
      .bind(now, sig)
      .run();
    return new Response(JSON.stringify({ ok: true, deduped: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const issueUrl = await createGithubIssue(env, payload);
  await env.DB
    .prepare(
      'INSERT INTO schema_reports (signature, version, locale, fields, issue_url, created_at, last_seen)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      sig,
      payload.version,
      payload.locale,
      JSON.stringify(payload.fields),
      issueUrl,
      now,
      now,
    )
    .run();

  return new Response(JSON.stringify({ ok: true, issueUrl }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
