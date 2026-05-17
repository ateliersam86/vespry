/**
 * Exporteurs de format — transforment les messages d'un salon en HTML, CSV
 * ou texte brut. Le JSON reste géré directement par le packager (sérialisation
 * fidèle, pas de mise en forme).
 *
 * Toutes les fonctions sont PURES (entrée → chaîne) : testables sans IndexedDB
 * ni réseau. Le packager les appelle une fois par salon et par format choisi.
 *
 * Les exporteurs vivent dans un sous-dossier du zip (`html/`, `csv/`, `txt/`),
 * d'où le préfixe `../` vers les médias rangés à la racine.
 */
import type {
  RawAttachment,
  RawEmbed,
  RawMessage,
  RawReaction,
} from './types';

/** Contexte passé à chaque exporteur. */
export interface ExportContext {
  guildName: string;
  channelName: string;
  /** url d'origine → chemin du média dans le zip (`media/slug/fichier`). */
  urlToPath: Map<string, string>;
}

/** Chemin d'un média relatif à un fichier d'export (dans `html/`, `txt/`…). */
function mediaHref(url: string, urlToPath: Map<string, string>): string | null {
  const p = urlToPath.get(url);
  return p ? `../${p}` : null;
}

/** Horodatage lisible, stable quelle que soit la locale du lecteur. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Nom affichable d'un auteur. */
function authorName(m: RawMessage): string {
  return m.author.global_name ?? m.author.username;
}

/**
 * Remplace les balises Discord brutes par du texte lisible. Commun au texte
 * brut et au CSV (le HTML applique en plus un rendu markdown).
 */
function humanize(text: string): string {
  return text
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<@!?\d+>/g, '@membre')
    .replace(/<@&\d+>/g, '@rôle')
    .replace(/<#\d+>/g, '#salon');
}

/** Résumé d'une réaction : `:emoji: ×N`. */
function reactionText(r: RawReaction): string {
  return `${r.emoji.name ?? '?'} ×${r.count}`;
}

// ─────────────────────────── TEXTE BRUT ───────────────────────────

/** Exporte un salon en texte brut. */
export function toTxt(ctx: ExportContext, messages: RawMessage[]): string {
  const out: string[] = [
    `${ctx.guildName} — #${ctx.channelName}`,
    `${messages.length} message(s)`,
    '='.repeat(60),
    '',
  ];
  for (const m of messages) {
    out.push(`[${fmtDate(m.timestamp)}] ${authorName(m)}`);
    if (m.content.trim()) {
      for (const line of humanize(m.content).split('\n')) out.push(line);
    }
    for (const a of m.attachments) {
      const local = mediaHref(a.url, ctx.urlToPath);
      out.push(`  [pièce jointe : ${a.filename}${local ? ` → ${local}` : ''}]`);
    }
    for (const e of m.embeds) {
      if (e.title || e.description) {
        out.push(`  [embed : ${humanize(e.title ?? e.description ?? '')}]`);
      }
    }
    if (m.reactions && m.reactions.length > 0) {
      out.push(`  [réactions : ${m.reactions.map(reactionText).join('  ')}]`);
    }
    out.push('');
  }
  return out.join('\n');
}

// ─────────────────────────────── CSV ───────────────────────────────

/** Échappe une valeur CSV (RFC 4180 : guillemets doublés si besoin). */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Liste des pièces jointes pour une cellule CSV. */
function attachmentsCell(m: RawMessage, urlToPath: Map<string, string>): string {
  return m.attachments
    .map((a) => mediaHref(a.url, urlToPath) ?? a.filename)
    .join(' | ');
}

/**
 * Exporte un salon en CSV. Colonnes proches de DiscordChatExporter pour la
 * compatibilité : id auteur, auteur, date ISO, contenu, pièces jointes,
 * réactions.
 */
export function toCsv(_ctx: ExportContext, messages: RawMessage[]): string {
  const header = ['AuthorID', 'Author', 'Date', 'Content', 'Attachments', 'Reactions'];
  const rows = [header.join(',')];
  for (const m of messages) {
    rows.push([
      csvCell(m.author.id),
      csvCell(authorName(m)),
      csvCell(m.timestamp),
      csvCell(humanize(m.content)),
      csvCell(attachmentsCell(m, _ctx.urlToPath)),
      csvCell((m.reactions ?? []).map(reactionText).join(' ')),
    ].join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}

// ─────────────────────────────── HTML ───────────────────────────────

/** Échappe le texte pour une insertion HTML sûre. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rend le contenu d'un message en HTML : échappement d'abord, puis markdown
 * Discord minimal (gras, italique, barré, code, citations, liens), enfin les
 * sauts de ligne. L'ordre échappement → markdown évite toute injection.
 */
function renderContent(raw: string): string {
  let s = esc(humanize(raw));
  s = s.replace(/```([\s\S]+?)```/g, (_m, c: string) => `<pre>${c.trim()}</pre>`);
  s = s.replace(/`([^`]+?)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+?)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener">$1</a>');
  return s.replace(/\n/g, '<br>');
}

/** Pastille d'avatar : initiale colorée — self-contained, pas de média externe. */
function avatarChip(m: RawMessage): string {
  const name = authorName(m);
  const initial = esc(name.slice(0, 1).toUpperCase());
  // Teinte dérivée de l'id auteur — stable, lisible sur fond sombre.
  let hash = 0;
  for (const ch of m.author.id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `<div class="av" style="background:hsl(${hash} 45% 42%)">${initial}</div>`;
}

/** Une pièce jointe en HTML : image inline, sinon lien. */
function renderAttachment(a: RawAttachment, urlToPath: Map<string, string>): string {
  const href = mediaHref(a.url, urlToPath) ?? a.url;
  const isImage = (a.content_type ?? '').startsWith('image/')
    || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(a.url);
  if (isImage) {
    return `<a href="${esc(href)}"><img class="att-img" src="${esc(href)}" alt="${esc(a.filename)}" loading="lazy"></a>`;
  }
  return `<a class="att-file" href="${esc(href)}">📎 ${esc(a.filename)}</a>`;
}

/** Une carte d'embed simplifiée. */
function renderEmbed(e: RawEmbed): string {
  const parts: string[] = ['<div class="embed">'];
  if (e.author?.name) parts.push(`<div class="embed-author">${esc(e.author.name)}</div>`);
  if (e.title) parts.push(`<div class="embed-title">${esc(e.title)}</div>`);
  if (e.description) parts.push(`<div class="embed-desc">${renderContent(e.description)}</div>`);
  parts.push('</div>');
  return parts.join('');
}

/** Bandeau des réactions d'un message. */
function renderReactions(reactions: RawReaction[]): string {
  const chips = reactions
    .map((r) => `<span class="react">${esc(r.emoji.name ?? '?')} ${r.count}</span>`)
    .join('');
  return `<div class="reactions">${chips}</div>`;
}

/** Style intégré — page autonome, pas de fichier CSS externe. */
const HTML_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #1a1622; color: #e7e3f2;
    font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 18px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9991b3; font-size: 13px; margin-bottom: 24px; }
  .msg { display: flex; gap: 14px; padding: 6px 0; }
  .msg.grouped { padding-top: 0; }
  .av { width: 40px; height: 40px; border-radius: 50%; flex: none;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; color: #fff; }
  .av.spacer { background: none; }
  .body { min-width: 0; flex: 1; }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .author { font-weight: 600; color: #fff; }
  .time { font-size: 12px; color: #9991b3; }
  .content { white-space: normal; word-wrap: break-word; }
  .content a { color: #ab9ff0; }
  pre { background: #0f0c16; padding: 8px 10px; border-radius: 6px;
    overflow-x: auto; margin: 4px 0; }
  code { background: #0f0c16; padding: 1px 5px; border-radius: 4px; }
  .att-img { max-width: 380px; max-height: 300px; border-radius: 8px;
    margin-top: 6px; display: block; }
  .att-file { display: inline-block; margin-top: 4px; padding: 6px 10px;
    background: #2a2536; border-radius: 6px; color: #ab9ff0;
    text-decoration: none; }
  .embed { border-left: 3px solid #6c5ce0; background: #221d2e;
    padding: 8px 12px; border-radius: 4px; margin-top: 6px; }
  .embed-author { font-size: 12px; color: #9991b3; }
  .embed-title { font-weight: 600; margin: 2px 0; }
  .embed-desc { font-size: 14px; }
  .reactions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .react { background: #2a2536; border-radius: 999px; padding: 2px 9px;
    font-size: 13px; }
`;

/**
 * Exporte un salon en page HTML autonome, façon Discord. Les messages
 * consécutifs d'un même auteur (sous 7 minutes) sont groupés visuellement.
 */
export function toHtml(ctx: ExportContext, messages: RawMessage[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    const prev = messages[i - 1];
    const grouped = Boolean(
      prev
      && prev.author.id === m.author.id
      && Date.parse(m.timestamp) - Date.parse(prev.timestamp) < 7 * 60_000,
    );
    const parts: string[] = [`<div class="msg${grouped ? ' grouped' : ''}">`];
    parts.push(grouped ? '<div class="av spacer"></div>' : avatarChip(m));
    parts.push('<div class="body">');
    if (!grouped) {
      parts.push(
        `<div class="head"><span class="author">${esc(authorName(m))}</span>`
        + `<span class="time">${esc(fmtDate(m.timestamp))}</span></div>`,
      );
    }
    if (m.content.trim()) {
      parts.push(`<div class="content">${renderContent(m.content)}</div>`);
    }
    for (const a of m.attachments) parts.push(renderAttachment(a, ctx.urlToPath));
    for (const e of m.embeds) {
      if (e.title || e.description || e.author?.name) parts.push(renderEmbed(e));
    }
    if (m.reactions && m.reactions.length > 0) {
      parts.push(renderReactions(m.reactions));
    }
    parts.push('</div></div>');
    blocks.push(parts.join(''));
  }
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ctx.guildName)} — #${esc(ctx.channelName)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<div class="wrap">
<h1>#${esc(ctx.channelName)}</h1>
<div class="sub">${esc(ctx.guildName)} · ${messages.length} message(s) · exporté avec Vespry</div>
${blocks.join('\n')}
</div>
</body>
</html>`;
}
