/**
 * Exporteurs de format — transforment les messages d'un salon en HTML, CSV
 * ou texte brut. Le JSON reste géré directement par le packager (sérialisation
 * fidèle, pas de mise en forme).
 *
 * Deux modes par format :
 *
 * 1. **Bulk** (`toHtml`, `toCsv`, `toTxt`) — entrée `RawMessage[]` → chaîne
 *    complète. PURE, testable sans IndexedDB. Utilisé par le packager en
 *    profil `fast` (machine puissante, on charge tout en RAM pour aller vite).
 *
 * 2. **Streaming** (`htmlHeader`/`htmlMessage`/`htmlFooter`, etc.) — émet un
 *    fichier morceau par morceau. Le packager itère le curseur IndexedDB et
 *    appelle ces helpers sans jamais accumuler tous les messages. Utilisé en
 *    profils `balanced` et `low`. Les helpers sont PURS aussi : un message en
 *    entrée → une chaîne en sortie. Le contexte (grouping HTML, header CSV)
 *    est externalisé dans un objet `StreamState` que le packager fait évoluer.
 *
 * Les exporteurs vivent dans un sous-dossier du zip (`html/`, `csv/`, `txt/`),
 * d'où le préfixe `../` vers les médias rangés à la racine.
 */
import type {
  RawAttachment,
  RawComponent,
  RawEmbed,
  RawMessage,
  RawPoll,
  RawReaction,
} from './types';
import type { MentionLabels, ResolvedMentions } from '../ui/markdown';
import {
  humanize as humanizeMentions,
  renderInlineHtml,
} from '../ui/markdown';

/** Construit la table des mentions résolues depuis `message.mentions[]`. */
function resolvedFrom(m: RawMessage): ResolvedMentions {
  const users: Record<string, string> = {};
  for (const u of m.mentions ?? []) {
    users[u.id] = u.global_name ?? u.username;
  }
  return { users };
}

/**
 * Libellés traduits injectés dans les fichiers exportés. Construits par le
 * packager via `t()` — c'est la langue de l'utilisateur qui produit l'export
 * qui s'applique (les fichiers générés sont lus par lui-même).
 */
export interface ExportLabels {
  messages: string;
  edited: string;
  replyTo: string;
  attachment: string;
  sticker: string;
  embed: string;
  reactions: string;
  systemLabel: string;
  /** Libellé d'un message système sans contenu, p.ex. « message système (type 7) ». */
  systemMessage: (type: number) => string;
  exportedBy: string;
  poll: string;
  pollVotes: (n: number) => string;
  /** Étiquettes des mentions Discord (`@membre`, `@rôle`, `#salon`). */
  mentions: MentionLabels;
}

/** Contexte passé à chaque exporteur. */
export interface ExportContext {
  guildName: string;
  /**
   * Id du serveur — propagé dans l'enveloppe JSON et utilisé par les
   * exporters pour produire des références univoques quand plusieurs
   * exports sont concaténés (CSV cross-guild, BI).
   */
  guildId: string;
  channelName: string;
  /**
   * Identifiants complets du salon — id Snowflake + nom + type Discord
   * (0 = guild text, 1 = DM, 3 = group DM, 5 = announce, 10/11/12 = threads,
   * 15 = forum). Permet aux exports CSV/JSON de rester exploitables après
   * concaténation et donne aux agents IA une donnée univoque (l'ID).
   */
  channel: { id: string; name: string; type: number };
  /** url d'origine → chemin du média dans le zip (`media/slug/fichier`). */
  urlToPath: Map<string, string>;
  labels: ExportLabels;
}

/** Libellés anglais — fallback minimal pour les tests qui n'instancient pas `t()`. */
export const ENGLISH_LABELS: ExportLabels = {
  messages: 'messages',
  edited: 'edited',
  replyTo: 'in reply to',
  attachment: 'attachment',
  sticker: 'sticker',
  embed: 'embed',
  reactions: 'reactions',
  systemLabel: 'system',
  systemMessage: (type) => `system message (type ${type})`,
  exportedBy: 'exported with Vespry',
  poll: 'poll',
  pollVotes: (n) => `${n} votes`,
  mentions: { user: '@member', role: '@role', channel: '#channel' },
};

/** Chemin d'un média relatif à un fichier d'export (dans `html/`, `txt/`…). */
function mediaHref(url: string, urlToPath: Map<string, string>): string | null {
  const p = urlToPath.get(url);
  return p ? `../${p}` : null;
}

/** Chemin local si le média a été téléchargé, sinon l'URL d'origine (CDN). */
function mediaOrCdn(url: string, urlToPath: Map<string, string>): string {
  return mediaHref(url, urlToPath) ?? url;
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

/** Vrai si `edited_timestamp` indique un message modifié. */
function isEdited(m: RawMessage): boolean {
  return Boolean(m.edited_timestamp);
}

/**
 * Type Discord de message « normal » : 0 = standard, 19 = réponse.
 * Tout le reste (arrivée de membre, boost, épinglage…) est un message système.
 */
function isSystem(m: RawMessage): boolean {
  return m.type !== 0 && m.type !== 19;
}

/**
 * Remplace les balises Discord brutes par du texte lisible — délègue au module
 * partagé `ui/markdown` pour que mentions et i18n soient cohérentes entre
 * l'aperçu de l'extension et les fichiers exportés.
 */
function humanize(text: string, mentions: MentionLabels): string {
  return humanizeMentions(text, mentions);
}

/** Résumé d'une réaction : `:emoji: ×N`. */
function reactionText(r: RawReaction): string {
  return `${r.emoji.name ?? '?'} ×${r.count}`;
}

/** URL CDN d'un sticker selon son format (3 = Lottie, non affichable). */
function stickerUrl(id: string, formatType: number): string | null {
  if (formatType === 3) return null;
  return `https://media.discordapp.net/stickers/${id}.${formatType === 4 ? 'gif' : 'png'}`;
}

// ─────────────────────────── TEXTE BRUT ───────────────────────────

/** Exporte un salon en texte brut. */
export function toTxt(ctx: ExportContext, messages: RawMessage[]): string {
  const L = ctx.labels;
  const out: string[] = [
    `${ctx.guildName} — #${ctx.channelName}`,
    `${messages.length} ${L.messages}`,
    '='.repeat(60),
    '',
  ];
  for (const m of messages) {
    if (isSystem(m)) {
      out.push(`--- [${L.systemLabel}] ${humanize(m.content, L.mentions) || L.systemMessage(m.type)} ---`, '');
      continue;
    }
    const edited = isEdited(m) ? ` (${L.edited})` : '';
    out.push(`[${fmtDate(m.timestamp)}] ${authorName(m)}${edited}`);
    // Message cité en réponse.
    const ref = m.referenced_message;
    if (ref) {
      const snippet = humanize(ref.content, L.mentions).split('\n')[0] ?? '';
      out.push(`  ↪ ${L.replyTo} ${authorName(ref)} : ${snippet.slice(0, 80)}`);
    }
    if (m.content.trim()) {
      for (const line of humanize(m.content, L.mentions).split('\n')) out.push(line);
    }
    for (const a of m.attachments) {
      const local = mediaHref(a.url, ctx.urlToPath);
      out.push(`  [${L.attachment} : ${a.filename}${local ? ` → ${local}` : ''}]`);
    }
    for (const s of m.sticker_items ?? []) {
      out.push(`  [${L.sticker} : ${s.name}]`);
    }
    for (const e of m.embeds) {
      if (e.title || e.description) {
        out.push(`  [${L.embed} : ${humanize(e.title ?? e.description ?? '', L.mentions)}]`);
      }
    }
    if (m.poll) {
      const counts = pollCountByAnswerId(m.poll);
      out.push(`  [${L.poll}] ${m.poll.question.text ?? ''}`);
      for (const a of m.poll.answers) {
        const c = counts.get(a.answer_id);
        const v = c !== undefined ? ` (${L.pollVotes(c)})` : '';
        out.push(`    - ${a.poll_media.text ?? ''}${v}`);
      }
    }
    for (const c of flattenComponents(m.components ?? [])) {
      if (c.type === 2) {
        out.push(`  [bouton: ${(c.emoji?.name ? c.emoji.name + ' ' : '') + (c.label ?? '')}]`);
      } else {
        out.push(`  [menu: ${c.placeholder ?? ''}]`);
      }
    }
    if (m.reactions && m.reactions.length > 0) {
      out.push(`  [${L.reactions} : ${m.reactions.map(reactionText).join('  ')}]`);
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
 * réactions, et un indicateur « édité ».
 */
export function toCsv(ctx: ExportContext, messages: RawMessage[]): string {
  // Colonnes : ID + nom + type du salon en tête pour que la concaténation
  // multi-salons reste exploitable (filtres / TCD Excel). `Edited` distinct
  // de Date (Vespry est seul à le distinguer vs DCE/Discrub).
  const header = [
    'ChannelID', 'Channel', 'ChannelType',
    'AuthorID', 'Author', 'Date', 'Edited', 'Content', 'Attachments', 'Reactions',
  ];
  const rows = [header.join(',')];
  for (const m of messages) {
    rows.push([
      csvCell(ctx.channel.id),
      csvCell(ctx.channel.name),
      csvCell(String(ctx.channel.type)),
      csvCell(m.author.id),
      csvCell(authorName(m)),
      csvCell(m.timestamp),
      csvCell(isEdited(m) ? 'yes' : ''),
      csvCell(humanize(m.content, ctx.labels.mentions)),
      csvCell(attachmentsCell(m, ctx.urlToPath)),
      csvCell((m.reactions ?? []).map(reactionText).join(' ')),
    ].join(','));
  }
  // BOM UTF-8 (`﻿`) en tête : sans lui, Excel sous Windows interprète
  // le fichier en latin-1 et casse accents/emojis. Aucun coût côté Numbers,
  // LibreOffice, Google Sheets, awk/grep (BOM ignoré ou stripé).
  return `﻿${rows.join('\r\n')}\r\n`;
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
 * Rend le contenu d'un message en HTML — délègue au module partagé
 * `ui/markdown` pour rester aligné sur l'aperçu de l'extension.
 */
function renderContent(
  raw: string,
  mentions: MentionLabels,
  resolved: ResolvedMentions | undefined,
  urlToPath: Map<string, string>,
): string {
  // Resolver d'emoji custom : on a déjà téléchargé les emojis (collectAssets
  // les ramasse depuis content + reactions) ; on cherche le chemin local
  // dans `urlToPath`. Quand l'emoji a été téléchargé, on renvoie le path
  // relatif depuis `html/` (le sous-dossier où vivent les fichiers HTML).
  const emojiResolver = (id: string, animated: boolean): string | null => {
    const ext = animated ? 'gif' : 'png';
    const cdnUrl = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
    const localPath = urlToPath.get(cdnUrl);
    return localPath ? `../${localPath}` : null;
  };
  return renderInlineHtml(raw, mentions, resolved, emojiResolver);
}

/**
 * Avatar de l'auteur — image réelle (téléchargée dans `avatars/` du zip)
 * si dispo via urlToPath, sinon pastille initiale colorée comme fallback.
 *
 * Audit B+C 2026-05-18 : DCE et Discrub téléchargent les vrais avatars.
 * Vespry collecte déjà les bons URLs dans `collectAssets` (media.ts:170)
 * — il manquait juste leur utilisation côté rendu.
 */
function avatarChip(m: RawMessage, urlToPath?: Map<string, string>): string {
  const name = authorName(m);
  if (urlToPath && m.author.avatar) {
    const ext = m.author.avatar.startsWith('a_') ? 'gif' : 'png';
    const cdnUrl = `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.${ext}`;
    const localPath = urlToPath.get(cdnUrl);
    if (localPath) {
      // ../ : on est dans `html/`, le média vit à la racine du zip.
      return `<img class="av av-img" src="../${esc(localPath)}" alt="${esc(name)}" loading="lazy">`;
    }
  }
  const initial = esc(name.slice(0, 1).toUpperCase());
  // Fallback : teinte dérivée de l'id — stable, lisible sur fond sombre.
  let hash = 0;
  for (const ch of m.author.id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `<div class="av" style="background:hsl(${hash} 45% 42%)">${initial}</div>`;
}

/** Une pièce jointe en HTML : image / vidéo / audio inline, sinon lien. */
function renderAttachment(a: RawAttachment, urlToPath: Map<string, string>): string {
  const href = mediaOrCdn(a.url, urlToPath);
  const ct = a.content_type ?? '';
  const isImage = ct.startsWith('image/')
    || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(a.url);
  if (isImage) {
    return `<a href="${esc(href)}"><img class="att-img" src="${esc(href)}" alt="${esc(a.filename)}" loading="lazy"></a>`;
  }
  // Vidéo et audio rendus en lecteur natif (audit B+C 2026-05-18 : DCE et
  // Discrub le faisaient, Vespry tombait sur un lien-chip). `preload=none`
  // évite que le navigateur télécharge le média avant qu'on clique play —
  // important quand l'archive contient des dizaines de vidéos.
  const isVideo = ct.startsWith('video/')
    || /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i.test(a.url);
  if (isVideo) {
    const type = ct || 'video/mp4';
    return `<video class="att-video" controls preload="none">`
      + `<source src="${esc(href)}" type="${esc(type)}">`
      + `<a href="${esc(href)}">📎 ${esc(a.filename)}</a></video>`;
  }
  const isAudio = ct.startsWith('audio/')
    || /\.(mp3|ogg|oga|wav|m4a|flac|opus)(\?|$)/i.test(a.url);
  if (isAudio) {
    const type = ct || 'audio/mpeg';
    return `<audio class="att-audio" controls preload="none">`
      + `<source src="${esc(href)}" type="${esc(type)}">`
      + `<a href="${esc(href)}">📎 ${esc(a.filename)}</a></audio>`;
  }
  return `<a class="att-file" href="${esc(href)}">📎 ${esc(a.filename)}</a>`;
}

/** Un sticker en HTML (Lottie ignoré, faute d'image statique). */
function renderSticker(
  s: { id: string; name: string; format_type: number },
  urlToPath: Map<string, string>,
  labels: ExportLabels,
): string {
  const cdn = stickerUrl(s.id, s.format_type);
  if (!cdn) {
    return `<span class="sticker-name">[${esc(labels.sticker)} : ${esc(s.name)}]</span>`;
  }
  return `<img class="sticker" src="${esc(mediaOrCdn(cdn, urlToPath))}" alt="${esc(s.name)}" title="${esc(s.name)}" loading="lazy">`;
}

/** Carte d'embed complète : couleur, auteur, titre, description, champs, image, footer. */
function renderEmbed(
  e: RawEmbed,
  urlToPath: Map<string, string>,
  mentions: MentionLabels,
): string {
  const color = typeof e.color === 'number'
    ? `#${e.color.toString(16).padStart(6, '0')}`
    : '#6c5ce0';
  const parts: string[] = [`<div class="embed" style="border-color:${color}">`];
  if (e.author?.name) {
    parts.push(`<div class="embed-author">${esc(e.author.name)}</div>`);
  }
  if (e.title) {
    parts.push(
      e.url
        ? `<div class="embed-title"><a href="${esc(e.url)}" rel="noopener noreferrer">${esc(e.title)}</a></div>`
        : `<div class="embed-title">${esc(e.title)}</div>`,
    );
  }
  if (e.description) {
    parts.push(`<div class="embed-desc">${renderContent(e.description, mentions, undefined, urlToPath)}</div>`);
  }
  if (e.fields && e.fields.length > 0) {
    parts.push('<div class="embed-fields">');
    for (const f of e.fields) {
      parts.push(
        `<div class="embed-field"><div class="embed-fn">${esc(f.name)}</div>`
        + `<div class="embed-fv">${renderContent(f.value, mentions, undefined, urlToPath)}</div></div>`,
      );
    }
    parts.push('</div>');
  }
  const img = e.image?.url ?? e.thumbnail?.url;
  if (img) {
    parts.push(`<img class="embed-img" src="${esc(mediaOrCdn(img, urlToPath))}" alt="" loading="lazy">`);
  }
  if (e.footer?.text) {
    parts.push(`<div class="embed-footer">${esc(e.footer.text)}</div>`);
  }
  parts.push('</div>');
  return parts.join('');
}

/** Aperçu du message cité par une réponse ou un transfert. */
function renderReply(
  ref: RawMessage,
  mentions: MentionLabels,
  forwarded: boolean,
): string {
  const snippet = humanize(ref.content, mentions).replace(/\n/g, ' ').slice(0, 200);
  const cls = forwarded ? 'reply forward' : 'reply';
  const arrow = forwarded ? '↗' : '↪';
  return (
    `<div class="${cls}"><span class="reply-arrow">${arrow}</span>`
    + `<span class="reply-author">${esc(authorName(ref))}</span>`
    + `<span class="reply-text">${esc(snippet)}</span></div>`
  );
}

/** Vrai si ce message est un transfert (Discord `message_reference.type = 1`). */
function isForwarded(m: RawMessage): boolean {
  return m.message_reference?.type === 1;
}

/** Compteur de votes d'une option de sondage (id → count). */
function pollCountByAnswerId(poll: RawPoll): Map<number, number> {
  const map = new Map<number, number>();
  for (const c of poll.results?.answer_counts ?? []) map.set(c.id, c.count);
  return map;
}

/** Rend un sondage Discord en HTML : question + options + votes. */
function renderPoll(poll: RawPoll, labels: ExportLabels): string {
  const counts = pollCountByAnswerId(poll);
  const items = poll.answers.map((a) => {
    const txt = esc(a.poll_media.text ?? '');
    const emoji = a.poll_media.emoji?.name
      ? `<span class="poll-emoji">${esc(a.poll_media.emoji.name)}</span> `
      : '';
    const c = counts.get(a.answer_id);
    const votes = c !== undefined
      ? ` <span class="poll-votes">· ${esc(labels.pollVotes(c))}</span>`
      : '';
    return `<li>${emoji}${txt}${votes}</li>`;
  }).join('');
  const q = esc(poll.question.text ?? '');
  return (
    `<div class="poll"><div class="poll-title">[${esc(labels.poll)}]</div>`
    + `<div class="poll-question">${q}</div><ul class="poll-answers">${items}</ul></div>`
  );
}

/** Aplatit récursivement les composants : on extrait boutons et menus utiles. */
function flattenComponents(components: RawComponent[]): RawComponent[] {
  const out: RawComponent[] = [];
  const walk = (list: RawComponent[]): void => {
    for (const c of list) {
      if (c.type === 1 && c.components) walk(c.components);
      else if (c.type === 2 || (c.type >= 3 && c.type <= 8)) out.push(c);
    }
  };
  walk(components);
  return out;
}

/** Rend un bouton ou un menu en HTML — visuel uniquement, non interactif. */
function renderComponent(c: RawComponent): string {
  if (c.type === 2) {
    // Bouton : style 5 = lien externe → balise <a>, sinon <span> visuel.
    const label = esc((c.emoji?.name ? `${c.emoji.name} ` : '') + (c.label ?? ''));
    if (c.style === 5 && c.url) {
      return `<a class="comp-btn link" href="${esc(c.url)}" rel="noopener noreferrer">${label}</a>`;
    }
    return `<span class="comp-btn${c.disabled ? ' disabled' : ''}">${label || '—'}</span>`;
  }
  // Menu déroulant : on liste les options si présentes.
  const ph = esc(c.placeholder ?? '');
  if (c.options && c.options.length > 0) {
    const opts = c.options
      .map((o) => `<li>${esc(o.label)}</li>`).join('');
    return `<div class="comp-menu"><span class="comp-menu-label">▾ ${ph || '—'}</span><ul>${opts}</ul></div>`;
  }
  return `<span class="comp-menu-label">▾ ${ph || '—'}</span>`;
}

/** Rend l'ensemble des composants d'un message. Null si vide. */
function renderComponents(components: RawComponent[] | undefined): string | null {
  if (!components || components.length === 0) return null;
  const flat = flattenComponents(components);
  if (flat.length === 0) return null;
  return `<div class="components">${flat.map(renderComponent).join('')}</div>`;
}

/**
 * Bandeau des réactions d'un message. Emoji custom (avec `id`) rendu en
 * image téléchargée si dispo ; emoji Unicode standard ou non-téléchargé
 * tombent en texte. Audit B+C : avant, on rendait juste `name` en texte
 * peu importe le type (les emojis custom devenaient `?` ou un nom brut).
 */
function renderReactions(
  reactions: RawReaction[],
  urlToPath: Map<string, string>,
): string {
  const chips = reactions.map((r) => {
    const { id, name, animated } = r.emoji;
    let body: string;
    if (id) {
      const ext = animated ? 'gif' : 'png';
      const cdnUrl = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
      const localPath = urlToPath.get(cdnUrl);
      body = localPath
        ? `<img class="emoji" src="../${esc(localPath)}" alt=":${esc(name ?? '')}:">`
        : esc(name ?? '?');
    } else {
      // Emoji Unicode (sans id) : juste le caractère, suffisant côté visuel.
      body = esc(name ?? '?');
    }
    return `<span class="react">${body} ${r.count}</span>`;
  }).join('');
  return `<div class="reactions">${chips}</div>`;
}

/** Style intégré — page autonome, pas de fichier CSS externe. */
/** Style CSS injecté dans chaque export HTML (page autonome). */
const HTML_STYLE_POLL = `
  .poll { background: #221d2e; border: 1px solid #2a2536; border-radius: 8px;
    padding: 10px 12px; margin-top: 6px; max-width: 520px; }
  .poll-title { font-size: 11px; color: #9991b3; text-transform: uppercase;
    letter-spacing: .5px; margin-bottom: 4px; }
  .poll-question { font-weight: 600; margin-bottom: 6px; }
  .poll-answers { list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 4px; }
  .poll-answers li { background: #1a1622; border-radius: 6px;
    padding: 6px 10px; font-size: 14px; }
  .poll-votes { color: #9991b3; font-size: 12px; }
  .poll-emoji { margin-right: 4px; }
  .spoiler { background: #2a2536; color: transparent; border-radius: 4px;
    padding: 0 4px; cursor: pointer; transition: color .2s ease, background .2s ease; }
  .spoiler:hover { color: inherit; background: transparent; }
  .components { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .comp-btn { display: inline-block; padding: 6px 12px; border-radius: 4px;
    background: #4f46c5; color: #fff; font-size: 13px; font-weight: 600;
    text-decoration: none; }
  .comp-btn.link { background: #2a2536; }
  .comp-btn.disabled { opacity: .5; }
  .comp-menu { background: #221d2e; border: 1px solid #2a2536; border-radius: 6px;
    padding: 6px 10px; font-size: 13px; }
  .comp-menu-label { color: #9991b3; font-weight: 600; }
  .comp-menu ul { list-style: none; padding: 4px 0 0; margin: 0; font-size: 12.5px; }
  .comp-menu li { padding: 2px 0; color: #c8c2da; }
`;

const HTML_STYLE = HTML_STYLE_POLL + `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #1a1622; color: #e7e3f2;
    font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 18px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9991b3; font-size: 13px; margin-bottom: 24px; }
  .sys { text-align: center; color: #9991b3; font-size: 13px; padding: 6px 0; }
  .msg { display: flex; gap: 14px; padding: 6px 0; }
  .msg.grouped { padding-top: 0; }
  .av { width: 40px; height: 40px; border-radius: 50%; flex: none;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; color: #fff; }
  /* Avatar réel téléchargé : on garde la même boîte 40×40 ronde. */
  .av-img { object-fit: cover; background: #2a2536; }
  .av.spacer { background: none; }
  .body { min-width: 0; flex: 1; }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .author { font-weight: 600; color: #fff; }
  .time { font-size: 12px; color: #9991b3; }
  .edited { font-size: 11px; color: #9991b3; font-style: italic; }
  .content { white-space: normal; word-wrap: break-word; }
  .content a { color: #ab9ff0; }
  pre { background: #0f0c16; padding: 8px 10px; border-radius: 6px;
    overflow-x: auto; margin: 4px 0; }
  code { background: #0f0c16; padding: 1px 5px; border-radius: 4px; }
  .reply { display: flex; gap: 6px; font-size: 13px; color: #9991b3;
    margin-bottom: 2px; padding-left: 8px; border-left: 2px solid #4a4458; }
  .reply-author { font-weight: 600; color: #ab9ff0; }
  .reply-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .att-video, .att-audio {
    display: block; margin-top: 6px; max-width: 480px; width: 100%;
    border-radius: 8px; background: #0f0c16;
  }
  .att-audio { max-width: 380px; }
  .att-img { max-width: 380px; max-height: 300px; border-radius: 8px;
    margin-top: 6px; display: block; }
  .att-file { display: inline-block; margin-top: 4px; padding: 6px 10px;
    background: #2a2536; border-radius: 6px; color: #ab9ff0;
    text-decoration: none; }
  .sticker { max-width: 160px; max-height: 160px; margin-top: 6px; display: block; }
  .sticker-name { color: #9991b3; font-size: 13px; }
  .embed { border-left: 4px solid #6c5ce0; background: #221d2e;
    padding: 8px 12px; border-radius: 4px; margin-top: 6px; max-width: 520px; }
  .embed-author { font-size: 12px; color: #9991b3; }
  .embed-title { font-weight: 600; margin: 2px 0; }
  .embed-title a { color: #ab9ff0; text-decoration: none; }
  .embed-desc { font-size: 14px; }
  .embed-fields { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .embed-field { min-width: 140px; }
  .embed-fn { font-weight: 600; font-size: 13px; }
  .embed-fv { font-size: 13px; color: #c8c2da; }
  .embed-img { max-width: 100%; border-radius: 6px; margin-top: 6px; }
  .embed-footer { font-size: 12px; color: #9991b3; margin-top: 6px; }
  .reactions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .react { background: #2a2536; border-radius: 999px; padding: 2px 9px;
    font-size: 13px; }
  /* Mentions Discord : pilule violette pâle, comme dans le client Discord.
     Couleurs séparées user / role / channel pour distinction visuelle. */
  .mention {
    background: rgba(108, 92, 224, .22); color: #d6cfff;
    padding: 0 4px; border-radius: 4px; font-weight: 600;
    text-decoration: none;
  }
  .mention--role { background: rgba(214, 168, 90, .20); color: #f0d6a1; }
  .mention--channel { background: rgba(80, 138, 220, .22); color: #b9d3ff; }
  /* Bot tag à côté du nom d'auteur — signal visuel standard (Discord
     officiel, DCE, Discrub) que ce message vient d'une application/bot. */
  .bot-tag {
    background: #5865f2; color: #fff;
    padding: 1px 6px; border-radius: 4px;
    font-size: 10px; font-weight: 700; letter-spacing: .3px;
    margin-left: 2px; vertical-align: 2px;
  }
  /* Emoji custom inline rendu en image (téléchargé dans emojis/ du zip).
     22 px = taille canonique Discord. La barre de hauteur 1.5em du conteneur
     reste cohérente avec le texte autour. */
  .emoji {
    width: 22px; height: 22px;
    vertical-align: -5px;
    display: inline-block;
    object-fit: contain;
  }
  /* Réactions : emoji custom téléchargé rendu en image (cf. renderReactions). */
  .react .emoji { width: 18px; height: 18px; margin-right: 2px; vertical-align: -3px; }

  /* ─── Impression — Vespry est le premier à le gérer parmi DCE/Discrub ───
     Tous les exports HTML concurrents sont en dark sans @media print.
     Soit le navigateur imprime le fond foncé (forêt d'encre), soit il ne
     l'imprime pas et on a du texte clair sur blanc → invisible. On force
     un thème clair lisible pour le print, on évite la coupure de messages,
     et on imprime l'URL des liens (sans la perdre comme avec du texte gris).
     Audit B+C, 2026-05-18. */
  @media print {
    :root { color-scheme: light; }
    body {
      background: #fff !important; color: #111 !important;
      font-family: "Segoe UI", system-ui, sans-serif !important;
    }
    .wrap { max-width: none; padding: 12mm; }
    /* Évite qu'un message soit coupé entre deux pages. */
    .msg, .embed, .poll, .reply { break-inside: avoid; page-break-inside: avoid; }
    .author { color: #111 !important; }
    .time, .edited, .sys, .reply { color: #555 !important; }
    /* Imprime l'URL effective des liens — sinon le lecteur perd la cible. */
    .content a::after { content: " (" attr(href) ")"; font-size: 11px; color: #555; }
    /* Avatar pastille sur fond clair = peu lisible, on ajoute un liseré. */
    .av { border: 1px solid #ccc; box-shadow: none; }
    .reply { border-left-color: #999 !important; }
    .embed { border-left-color: #777 !important; background: #f5f5f7 !important; }
    .reactions .react {
      background: transparent !important;
      border: 1px solid #999; color: #111 !important;
    }
    pre, code { background: #f5f5f7 !important; color: #111 !important; }
    /* Image et stickers réduits pour ne pas déborder en portrait étroit. */
    .att-img, .embed-img, .embed-thumb, .sticker-img {
      max-width: 100% !important; max-height: 200px !important;
    }
    /* Composants interactifs (boutons, menus) n'ont aucun sens en print. */
    .components, .att-file { display: none !important; }
  }
`;

/** Rend un message système : ligne centrée et discrète. */
function renderSystemMessage(m: RawMessage, labels: ExportLabels): string {
  const label = humanize(m.content, labels.mentions).trim() || labels.systemMessage(m.type);
  return `<div class="sys">— ${esc(label)} · ${esc(fmtDate(m.timestamp))} —</div>`;
}

/** Rend un message normal (par défaut ou réponse). */
function renderMessage(m: RawMessage, grouped: boolean, ctx: ExportContext): string {
  const L = ctx.labels;
  const parts: string[] = [`<div class="msg${grouped ? ' grouped' : ''}">`];
  parts.push(grouped ? '<div class="av spacer"></div>' : avatarChip(m, ctx.urlToPath));
  parts.push('<div class="body">');
  if (m.referenced_message) parts.push(renderReply(m.referenced_message, L.mentions, isForwarded(m)));
  if (!grouped) {
    const edited = isEdited(m) ? ` <span class="edited">(${esc(L.edited)})</span>` : '';
    // Bot tag à côté du nom — DCE et Discrub le mettent, c'est le signal
    // visuel standard que ce message vient d'une application/bot. Audit
    // B+C 2026-05-18.
    const botTag = m.author.bot
      ? ' <span class="bot-tag">BOT</span>'
      : '';
    parts.push(
      `<div class="head"><span class="author">${esc(authorName(m))}</span>${botTag}`
      + `<span class="time">${esc(fmtDate(m.timestamp))}</span>${edited}</div>`,
    );
  }
  if (m.content.trim()) {
    parts.push(`<div class="content">${renderContent(m.content, L.mentions, resolvedFrom(m), ctx.urlToPath)}</div>`);
  }
  for (const a of m.attachments) parts.push(renderAttachment(a, ctx.urlToPath));
  for (const s of m.sticker_items ?? []) parts.push(renderSticker(s, ctx.urlToPath, L));
  for (const e of m.embeds) {
    if (e.title || e.description || e.author?.name || e.image?.url) {
      parts.push(renderEmbed(e, ctx.urlToPath, L.mentions));
    }
  }
  if (m.poll) parts.push(renderPoll(m.poll, L));
  const components = renderComponents(m.components);
  if (components) parts.push(components);
  if (m.reactions && m.reactions.length > 0) {
    parts.push(renderReactions(m.reactions, ctx.urlToPath));
  }
  parts.push('</div></div>');
  return parts.join('');
}

/**
 * Exporte un salon en page HTML autonome, façon Discord. Les messages
 * consécutifs d'un même auteur (sous 7 minutes) sont groupés visuellement ;
 * les messages système coupent le groupement.
 */
export function toHtml(ctx: ExportContext, messages: RawMessage[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    if (isSystem(m)) {
      blocks.push(renderSystemMessage(m, ctx.labels));
      continue;
    }
    const prev = messages[i - 1];
    const grouped = Boolean(
      prev
      && !isSystem(prev)
      && prev.author.id === m.author.id
      && !m.referenced_message
      && Date.parse(m.timestamp) - Date.parse(prev.timestamp) < 7 * 60_000,
    );
    blocks.push(renderMessage(m, grouped, ctx));
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
<div class="sub">${esc(ctx.guildName)} · ${messages.length} ${esc(ctx.labels.messages)} · ${esc(ctx.labels.exportedBy)}</div>
${blocks.join('\n')}
</div>
</body>
</html>`;
}

// ─────────────────────── VARIANTES STREAMING ───────────────────────
//
// Les exporteurs bulk ci-dessus produisent toute la chaîne en une fois. En
// streaming on émet header → corps message-par-message → footer. Le packager
// itère le curseur IndexedDB et concatène les morceaux dans un ReadableStream
// (cf. `packageRun`).

/**
 * État entretenu par le packager pendant qu'il streame un salon. Permet aux
 * helpers de connaître le message précédent (regroupement HTML) et de savoir
 * combien de messages ont déjà été émis (séparateurs JSON, comptage).
 */
export interface StreamState {
  /** Index 0-based du prochain message à émettre — sert au séparateur JSON. */
  index: number;
  /** Dernier message émis (non système) — pour le regroupement visuel HTML. */
  prev: RawMessage | null;
}

/** Crée un état neuf. */
export function createStreamState(): StreamState {
  return { index: 0, prev: null };
}

// HTML stream ─────────────────────────────────────────────────────────

/** Entête HTML : `<!doctype>` jusqu'à `<div class="sub">…`, sans le footer. */
export function htmlHeader(ctx: ExportContext, messageCount: number): string {
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
<div class="sub">${esc(ctx.guildName)} · ${messageCount} ${esc(ctx.labels.messages)} · ${esc(ctx.labels.exportedBy)}</div>
`;
}

/** Rend UN message HTML et met à jour l'état (regroupement). */
export function htmlMessage(
  ctx: ExportContext,
  state: StreamState,
  m: RawMessage,
): string {
  let chunk: string;
  if (isSystem(m)) {
    chunk = renderSystemMessage(m, ctx.labels);
  } else {
    const prev = state.prev;
    const grouped = Boolean(
      prev
      && !isSystem(prev)
      && prev.author.id === m.author.id
      && !m.referenced_message
      && Date.parse(m.timestamp) - Date.parse(prev.timestamp) < 7 * 60_000,
    );
    chunk = renderMessage(m, grouped, ctx);
  }
  state.prev = m;
  state.index += 1;
  // Saut de ligne entre blocs comme dans la version bulk (`blocks.join('\n')`).
  return state.index === 1 ? chunk : `\n${chunk}`;
}

/** Footer HTML qui ferme la page. */
export function htmlFooter(): string {
  return `\n</div>\n</body>\n</html>`;
}

// CSV stream ──────────────────────────────────────────────────────────

const CSV_HEADER =
  'AuthorID,Author,Date,Edited,Content,Attachments,Reactions\r\n';

/** Première ligne CSV — colonnes. À émettre une seule fois par fichier. */
export function csvHeader(): string {
  return CSV_HEADER;
}

/** Une ligne CSV pour un message. Inclut le `\r\n` final. */
export function csvMessage(ctx: ExportContext, m: RawMessage): string {
  return [
    csvCell(m.author.id),
    csvCell(authorName(m)),
    csvCell(m.timestamp),
    csvCell(isEdited(m) ? 'yes' : ''),
    csvCell(humanize(m.content, ctx.labels.mentions)),
    csvCell(attachmentsCell(m, ctx.urlToPath)),
    csvCell((m.reactions ?? []).map(reactionText).join(' ')),
  ].join(',') + '\r\n';
}

// TXT stream ──────────────────────────────────────────────────────────

/** Entête texte (titre + total + séparateur). */
export function txtHeader(ctx: ExportContext, messageCount: number): string {
  const L = ctx.labels;
  return [
    `${ctx.guildName} — #${ctx.channelName}`,
    `${messageCount} ${L.messages}`,
    '='.repeat(60),
    '',
    '',
  ].join('\n');
}

/** Bloc texte d'un message (suivi d'une ligne vide). */
export function txtMessage(ctx: ExportContext, m: RawMessage): string {
  // On réutilise `toTxt` avec un tableau d'un seul élément, puis on retire
  // l'entête (3 premières lignes + ligne vide). Le coût est négligeable et
  // ça garantit le rendu strictement identique à la version bulk.
  const single = toTxt(ctx, [m]);
  // L'entête fait quatre `\n` : titre, compteur, séparateur, ligne vide.
  const headerEnd = nthIndex(single, '\n', 4);
  return headerEnd >= 0 ? single.slice(headerEnd + 1) : single;
}

/** Position du `n`-ième occurrence d'un caractère, ou -1. */
function nthIndex(s: string, ch: string, n: number): number {
  let pos = -1;
  for (let k = 0; k < n; k += 1) {
    pos = s.indexOf(ch, pos + 1);
    if (pos === -1) return -1;
  }
  return pos;
}
