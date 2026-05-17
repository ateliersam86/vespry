/**
 * Overlay Vespry — UI Preact injectée dans la page Discord (Shadow DOM).
 *
 * Header de confirmation · rail serveurs · liste salons sélectionnable ·
 * personnalisation du salon · file d'export avec détails (stats + console).
 * Toutes les chaînes passent par i18n (`t`).
 */
import { type ComponentChildren, type JSX } from 'preact';
import { useEffect, useMemo, useReducer, useState } from 'preact/hooks';
import {
  ALL_MEDIA,
  hasActiveFilter,
  type MediaSelection,
  type MessageFilters,
} from '../../engine/checkpoint-types';
import {
  ChannelType,
  type RawAttachment,
  type RawChannel,
  type RawGuild,
  type RawMessage,
  type RawUser,
} from '../../engine/types';
import type { EnqueueExtras, QueueItemView } from '../../messaging';
import type { RemoteController } from '../../ui/remote-controller';
import { t } from '../../ui/i18n';
import { getVersion } from '../../version';
import { reportProblem } from '../../diagnostics';
import { loadCredits, type Credits } from '../../credits';
import {
  getThemePref,
  nextThemePref,
  resolveTheme,
  setThemePref,
  type ThemePref,
} from '../../ui/theme-pref';
import {
  IconMoon, IconSun, IconAuto, IconHeart, IconMail, IconCheck, IconMinus,
  IconChevronDown, IconChevronRight, IconClose, IconMinimize, IconExpand,
  IconDownload, OwlMark,
} from '../../ui/icons';

/** Icône du thème courant (cyclé sombre → clair → auto). */
function ThemeIcon({ pref }: { pref: ThemePref }): JSX.Element {
  if (pref === 'dark') return <IconMoon />;
  if (pref === 'light') return <IconSun />;
  return <IconAuto />;
}

/** URL de l'icône d'un serveur Discord (CDN), ou null s'il n'en a pas. */
function guildIconUrl(g: RawGuild): string | null {
  if (!g.icon) return null;
  const ext = g.icon.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.${ext}?size=64`;
}

/** Ligne case à cocher + libellé (options, filtres booléens). */
function CheckRow({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}): JSX.Element {
  return (
    <div class="v-checkrow" onClick={onToggle}>
      <span class={`v-cbx ${on ? 'on' : ''}`}>{on ? <IconCheck /> : null}</span>
      {label}
    </div>
  );
}

const EXPORTABLE = new Set<number>([
  ChannelType.GUILD_TEXT,
  ChannelType.GUILD_ANNOUNCEMENT,
  ChannelType.GUILD_FORUM,
  ChannelType.DM,
  ChannelType.GROUP_DM,
]);

/** Identifiant synthétique de la « zone » messages privés dans le rail. */
const DM_ZONE = '@me';

const MEDIA_KEYS: (keyof MediaSelection)[] = ['images', 'videos', 'audio', 'files'];

interface CategoryGroup {
  id: string;
  name: string;
  channels: RawChannel[];
}

/** Vrai si le salon est une conversation privée (DM ou DM de groupe). */
function isDmChannel(c: RawChannel): boolean {
  return c.type === ChannelType.DM || c.type === ChannelType.GROUP_DM;
}

/**
 * Regroupe les salons par catégorie, dans l'ordre Discord. Pour la zone des
 * messages privés (`dmZone`), pas de catégories : un seul groupe nommé
 * « Conversations » — un DM n'est pas un « salon ».
 */
function groupChannels(all: RawChannel[], dmZone: boolean): CategoryGroup[] {
  const cats = all
    .filter((c) => c.type === ChannelType.GUILD_CATEGORY)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const text = all
    .filter((c) => EXPORTABLE.has(c.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const groups: CategoryGroup[] = [];
  const orphans = text.filter((c) => !c.parent_id);
  if (orphans.length) {
    groups.push({
      id: '_',
      name: dmZone ? t('overlay.conversations') : t('overlay.uncategorized'),
      channels: orphans,
    });
  }
  for (const cat of cats) {
    const channels = text.filter((c) => c.parent_id === cat.id);
    if (channels.length) {
      groups.push({ id: cat.id, name: cat.name ?? '—', channels });
    }
  }
  return groups;
}

/** Re-render quand le contrôleur notifie. */
function useControllerTick(controller: RemoteController): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => controller.subscribe(force as () => void), [controller]);
}

export function Overlay({
  controller,
  onClose,
}: {
  controller: RemoteController;
  onClose: () => void;
}): JSX.Element {
  useControllerTick(controller);

  const [activeGuild, setActiveGuild] = useState<RawGuild | null>(null);
  const [channels, setChannels] = useState<RawChannel[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [media, setMedia] = useState<MediaSelection>({ ...ALL_MEDIA });
  const [focus, setFocus] = useState<RawChannel | null>(null);
  const [preview, setPreview] = useState<RawMessage[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [afterDate, setAfterDate] = useState('');
  const [beforeDate, setBeforeDate] = useState('');
  const [search, setSearch] = useState('');
  const [minimized, setMinimized] = useState(false);
  const [includeThreads, setIncludeThreads] = useState(true);
  // Filtres de contenu (au moins la parité Discrub).
  const [fContent, setFContent] = useState('');
  const [fAuthor, setFAuthor] = useState('');
  const [fMention, setFMention] = useState('');
  const [fPinned, setFPinned] = useState(false);
  const [fAttachment, setFAttachment] = useState(false);
  const [fLink, setFLink] = useState(false);
  const [reactionUsers, setReactionUsers] = useState(false);
  const [view, setView] = useState<'export' | 'credits'>('export');
  const [theme, setTheme] = useState<ThemePref>('dark');

  useEffect(() => {
    void getThemePref().then(setTheme);
  }, []);

  function cycleTheme(): void {
    const next = nextThemePref(theme);
    setTheme(next);
    setThemePref(next);
  }

  const resolvedTheme = resolveTheme(theme);

  // Sélectionne le premier serveur dès qu'ils sont chargés.
  useEffect(() => {
    if (!activeGuild && controller.guilds[0]) selectGuild(controller.guilds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.guilds.length]);

  // Aperçu : charge les messages récents du salon cliqué (façon Discord).
  useEffect(() => {
    if (!focus) {
      setPreview([]);
      setPreviewLoading(false);
      return undefined;
    }
    let cancelled = false;
    setPreview([]);
    setPreviewLoading(true);
    void controller.preview(focus.id).then((msgs) => {
      if (cancelled) return;
      setPreview(msgs);
      setPreviewLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.id]);

  function selectGuild(guild: RawGuild): void {
    setActiveGuild(guild);
    setChannels([]);
    setSelected(new Set());
    setFocus(null);
    setLoadingChannels(true);
    void controller.loadChannels(guild.id).then((ch) => {
      setChannels(ch);
      setLoadingChannels(false);
    });
  }

  const groups = useMemo(
    () => groupChannels(channels, activeGuild?.id === DM_ZONE),
    [channels, activeGuild],
  );
  const totalChannels = useMemo(
    () => groups.reduce((s, g) => s + g.channels.length, 0),
    [groups],
  );
  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        channels: g.channels.filter((c) => (c.name ?? '').toLowerCase().includes(q)),
      }))
      .filter((g) => g.channels.length > 0);
  }, [groups, search]);

  function toggleChannel(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleGroup(group: CategoryGroup): void {
    const next = new Set(selected);
    const allOn = group.channels.every((c) => next.has(c.id));
    for (const c of group.channels) {
      if (allOn) next.delete(c.id);
      else next.add(c.id);
    }
    setSelected(next);
  }

  function selectAll(on: boolean): void {
    if (!on) return setSelected(new Set());
    const next = new Set<string>();
    for (const g of groups) for (const c of g.channels) next.add(c.id);
    setSelected(next);
  }

  function enqueue(): void {
    if (!activeGuild || selected.size === 0) return;
    const picked = channels.filter((c) => selected.has(c.id));
    const extras: EnqueueExtras = { includeThreads };
    if (afterDate) extras.afterMs = Date.parse(afterDate);
    if (beforeDate) extras.beforeMs = Date.parse(beforeDate) + 86_399_999;
    if (reactionUsers) extras.includeReactionUsers = true;
    const filters: MessageFilters = {};
    if (fContent.trim()) filters.content = fContent.trim();
    if (fAuthor.trim()) filters.author = fAuthor.trim();
    if (fMention.trim()) filters.mention = fMention.trim();
    if (fPinned) filters.pinnedOnly = true;
    if (fAttachment) filters.hasAttachment = true;
    if (fLink) filters.hasLink = true;
    if (hasActiveFilter(filters)) extras.filters = filters;
    void controller.enqueue(activeGuild, picked, media, extras);
    setSelected(new Set());
    setFocus(null);
  }

  if (minimized) {
    return (
      <div class="v-root" data-theme={resolvedTheme}>
        <MiniWidget controller={controller} onExpand={() => setMinimized(false)} />
      </div>
    );
  }
  if (controller.error) {
    const noToken = controller.error === 'no-token';
    return (
      <Shell onClose={onClose} theme={resolvedTheme} compact>
        <div class="v-empty" style="flex:1">
          <OwlMark class="v-mark" />
          <strong>{noToken ? t('overlay.no_token_title') : t('overlay.engine_error')}</strong>
          <span>{noToken ? t('overlay.no_token_body') : controller.error}</span>
          <div style="display:flex;gap:10px;margin-top:8px">
            {noToken && (
              <button
                class="v-btn"
                onClick={() => { window.location.href = 'https://discord.com/login'; }}
              >
                {t('overlay.go_login')}
              </button>
            )}
            <button class="v-btn v-btn--ghost" onClick={() => window.location.reload()}>
              {t('overlay.reload')}
            </button>
          </div>
          {!noToken && (
            <ReportLink
              summary={`Overlay : ${controller.error}`}
              log={[]}
              label={t('report.problem')}
            />
          )}
        </div>
      </Shell>
    );
  }
  if (!controller.ready) {
    return (
      <Shell onClose={onClose} theme={resolvedTheme} compact>
        <div class="v-empty" style="flex:1">
          <OwlMark class="v-mark" />
          <span>{t('overlay.loading')}</span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose} theme={resolvedTheme}>
      {/* header de confirmation */}
      <div class="v-top">
        <span class="v-logo"><OwlMark class="v-mark" />Vespry</span>
        <span style="font-size:11px;color:var(--muted);font-weight:600">v{getVersion()}</span>
        <ReportLink summary="Problème signalé depuis Vespry" log={[]} label={t('report.problem')} />
        <span class="v-support-link" onClick={() => setView('credits')}>
          <IconHeart /> {t('credits.support')}
        </span>
        <span class="v-theme-btn" onClick={cycleTheme} title={t(`theme.${theme}`)}>
          <ThemeIcon pref={theme} /> {t(`theme.${theme}`)}
        </span>
        <span class="v-sum">
          {activeGuild ? (
            <>
              <b>{activeGuild.name}</b> ·{' '}
              {t('overlay.channels_summary', { n: selected.size, total: totalChannels })}
            </>
          ) : (
            t('overlay.choose_server')
          )}
        </span>
        <span class="v-close" onClick={() => setMinimized(true)} title={t('overlay.minimize')}>
          <IconMinimize />
        </span>
        <span class="v-close" onClick={onClose} title={t('overlay.close')}>
          <IconClose />
        </span>
      </div>

      {view === 'credits' ? (
        <CreditsPanel onBack={() => setView('export')} />
      ) : (
      <>
      <div class="v-mid">
        {/* rail serveurs */}
        <div class="v-rail">
          <div
            class={`v-sic ${activeGuild?.id === DM_ZONE ? 'act' : ''}`}
            title={t('overlay.dms')}
            onClick={() => selectGuild({ id: DM_ZONE, name: t('overlay.dms') })}
          >
            <IconMail />
          </div>
          {controller.guilds.map((g) => {
            const icon = guildIconUrl(g);
            return (
              <div
                key={g.id}
                class={`v-sic ${activeGuild?.id === g.id ? 'act' : ''}`}
                title={g.name}
                onClick={() => selectGuild(g)}
              >
                {icon
                  ? <img src={icon} alt="" loading="lazy" />
                  : g.name.slice(0, 2).toUpperCase()}
              </div>
            );
          })}
        </div>

        {/* liste des salons — l'en-tête est la case maître « tout le serveur » */}
        <div class="v-clist">
          <div
            class="v-clist-hd v-clist-master"
            onClick={() => selectAll(selected.size < totalChannels)}
            title={t('overlay.select_all')}
          >
            <span
              class={`v-cbx ${
                totalChannels > 0 && selected.size === totalChannels
                  ? 'on'
                  : selected.size > 0 ? 'part' : ''
              }`}
            >
              {totalChannels > 0 && selected.size === totalChannels
                ? <IconCheck />
                : selected.size > 0 ? <IconMinus /> : null}
            </span>
            <span class="v-clist-name">{activeGuild?.name ?? '—'}</span>
            {totalChannels > 0 && (
              <span class="v-clist-count">{selected.size}/{totalChannels}</span>
            )}
          </div>
          <input
            class="v-search"
            type="text"
            placeholder={t('overlay.search_channels')}
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
          <div class="v-clist-scroll">
            {loadingChannels && <div class="v-cat">{t('overlay.loading')}</div>}
            {visibleGroups.map((group) => {
              const on = group.channels.filter((c) => selected.has(c.id)).length;
              return (
                <div key={group.id}>
                  <div class="v-cat" onClick={() => toggleGroup(group)}>
                    <span
                      class={`v-cbx ${
                        on === group.channels.length ? 'on' : on > 0 ? 'part' : ''
                      }`}
                    >
                      {on === group.channels.length
                        ? <IconCheck />
                        : on > 0 ? <IconMinus /> : null}
                    </span>
                    {group.name}
                  </div>
                  {group.channels.map((c) => (
                    <div
                      key={c.id}
                      class={`v-crow ${focus?.id === c.id ? 'sel' : ''}`}
                      onClick={() => setFocus(c)}
                    >
                      <span
                        class={`v-cbx ${selected.has(c.id) ? 'on' : ''}`}
                        onClick={(e: MouseEvent) => {
                          e.stopPropagation();
                          toggleChannel(c.id);
                        }}
                      >
                        {selected.has(c.id) ? <IconCheck /> : null}
                      </span>
                      {!isDmChannel(c) && <span class="v-hash">#</span>}
                      {c.name}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* aperçu des messages — façon Discord */}
        <div class="v-chat">
          <div class="v-chat-hd">
            {focus && !isDmChannel(focus) && (
              <span class="v-hash" style="font-size:20px">#</span>
            )}
            <span class="v-name">{focus?.name ?? t('overlay.preview')}</span>
          </div>
          <MessagePreview channel={focus} messages={preview} loading={previewLoading} />
        </div>

        {/* panneau d'export — à droite */}
        <div class="v-side">
          <div class="v-side-hd">{t('overlay.settings')}</div>
          <div class="v-side-body">
            <div class="v-field">
              <label>{t('overlay.period_label')}</label>
              <div class="v-daterow">
                <input
                  class="v-date"
                  type="date"
                  value={afterDate}
                  onInput={(e) => setAfterDate((e.target as HTMLInputElement).value)}
                />
                <span class="v-muted">→</span>
                <input
                  class="v-date"
                  type="date"
                  value={beforeDate}
                  onInput={(e) => setBeforeDate((e.target as HTMLInputElement).value)}
                />
              </div>
            </div>
            <div class="v-field">
              <label>{t('overlay.media_label')}</label>
              <div class="v-mchips">
                {MEDIA_KEYS.map((key) => (
                  <span
                    key={key}
                    class={`v-mchip ${media[key] ? 'on' : ''}`}
                    onClick={() => setMedia({ ...media, [key]: !media[key] })}
                  >
                    {t(`media.${key}`)}
                  </span>
                ))}
              </div>
            </div>
            <div class="v-field">
              <label>{t('filter.section')}</label>
              <div class="v-filter-inputs">
                <input
                  class="v-input"
                  type="text"
                  placeholder={t('filter.author')}
                  value={fAuthor}
                  onInput={(e) => setFAuthor((e.target as HTMLInputElement).value)}
                />
                <input
                  class="v-input"
                  type="text"
                  placeholder={t('filter.content')}
                  value={fContent}
                  onInput={(e) => setFContent((e.target as HTMLInputElement).value)}
                />
                <input
                  class="v-input"
                  type="text"
                  placeholder={t('filter.mention')}
                  value={fMention}
                  onInput={(e) => setFMention((e.target as HTMLInputElement).value)}
                />
              </div>
              <CheckRow
                on={fPinned}
                onToggle={() => setFPinned(!fPinned)}
                label={t('filter.pinned')}
              />
              <CheckRow
                on={fAttachment}
                onToggle={() => setFAttachment(!fAttachment)}
                label={t('filter.has_attachment')}
              />
              <CheckRow
                on={fLink}
                onToggle={() => setFLink(!fLink)}
                label={t('filter.has_link')}
              />
            </div>
            <div class="v-field">
              <label>{t('filter.options')}</label>
              <CheckRow
                on={includeThreads}
                onToggle={() => setIncludeThreads(!includeThreads)}
                label={t('overlay.include_threads')}
              />
              <CheckRow
                on={reactionUsers}
                onToggle={() => setReactionUsers(!reactionUsers)}
                label={t('filter.reaction_users')}
              />
            </div>
            <div class="v-hint">
              {selected.size === 0
                ? t('overlay.hint_empty')
                : t('overlay.hint_selected', { n: selected.size })}
            </div>
          </div>
          <div class="v-side-foot">
            <button class="v-btn" disabled={selected.size === 0} onClick={enqueue}>
              {t('overlay.add_to_queue')}
            </button>
          </div>
        </div>
      </div>

      <ExportQueue controller={controller} onSupport={() => setView('credits')} />
      </>
      )}
    </Shell>
  );
}

function Shell({
  children,
  onClose,
  theme,
  compact = false,
}: {
  children: ComponentChildren;
  onClose: () => void;
  theme: 'dark' | 'light';
  /** Fenêtre réduite (carte « connecte-toi ») — grandit à la connexion. */
  compact?: boolean;
}): JSX.Element {
  return (
    <div class="v-root" data-theme={theme}>
      <div class="v-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {/* fond bokeh — taches floues douces derrière la fenêtre */}
        <div class="v-bokeh" aria-hidden="true">
          <i /><i /><i /><i /><i /><i />
        </div>
        <div class={`v-win ${compact ? 'v-win--compact' : ''}`}>{children}</div>
      </div>
    </div>
  );
}

/** URL d'avatar Discord d'un utilisateur (avatar par défaut si aucun). */
function avatarUrl(u: RawUser): string {
  if (u.avatar) {
    const ext = u.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext}?size=64`;
  }
  let idx = 0;
  try {
    idx = Number((BigInt(u.id) >> 22n) % 6n);
  } catch {
    /* id non numérique — avatar 0 par défaut */
  }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

/** Horodatage court et lisible. */
function formatTime(ts: string): string {
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Rend le contenu lisible : remplace les balises Discord brutes. */
function cleanContent(text: string): string {
  return text
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<@!?\d+>/g, '@membre')
    .replace(/<@&\d+>/g, '@rôle')
    .replace(/<#\d+>/g, '#salon');
}

/** Vrai si la pièce jointe est une image (affichable en vignette). */
function isImageAtt(a: RawAttachment): boolean {
  return (a.content_type ?? '').startsWith('image/')
    || /\.(png|jpe?g|gif|webp|avif|bmp)(\?|$)/i.test(a.url);
}

/** Une ligne de message dans l'aperçu (groupée = même auteur enchaîné). */
function MessageRow({
  message,
  grouped,
}: {
  message: RawMessage;
  grouped: boolean;
}): JSX.Element {
  const m = message;
  const name = m.author.global_name ?? m.author.username;
  return (
    <div class={`v-msg ${grouped ? 'v-msg--grouped' : ''}`}>
      {grouped
        ? <div class="v-msg-gutter" />
        : <img class="v-msg-avatar" src={avatarUrl(m.author)} alt="" loading="lazy" />}
      <div class="v-msg-main">
        {!grouped && (
          <div class="v-msg-head">
            <span class="v-msg-author">{name}</span>
            <span class="v-msg-time">{formatTime(m.timestamp)}</span>
          </div>
        )}
        {m.content && <div class="v-msg-content">{cleanContent(m.content)}</div>}
        {m.attachments.length > 0 && (
          <div class="v-msg-atts">
            {m.attachments.map((a) => (
              isImageAtt(a)
                ? (
                  <img
                    key={a.id}
                    class="v-msg-img"
                    src={a.proxy_url || a.url}
                    alt={a.filename}
                    loading="lazy"
                  />
                )
                : <span key={a.id} class="v-msg-file">{a.filename}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Aperçu des messages récents d'un salon — affichage façon Discord. */
function MessagePreview({
  channel,
  messages,
  loading,
}: {
  channel: RawChannel | null;
  messages: RawMessage[];
  loading: boolean;
}): JSX.Element {
  if (!channel) {
    return (
      <div class="v-empty" style="flex:1">
        <OwlMark class="v-mark" />
        <span>{t('preview.pick')}</span>
      </div>
    );
  }
  if (loading) {
    return <div class="v-empty" style="flex:1"><span>{t('overlay.loading')}</span></div>;
  }
  if (messages.length === 0) {
    return <div class="v-empty" style="flex:1"><span>{t('preview.empty')}</span></div>;
  }
  // L'API renvoie du plus récent au plus ancien — on rétablit l'ordre.
  const ordered = [...messages].reverse();
  return (
    <div class="v-msglist">
      {ordered.map((m, i) => {
        const prev = ordered[i - 1];
        const grouped = Boolean(
          prev
          && prev.author.id === m.author.id
          && Date.parse(m.timestamp) - Date.parse(prev.timestamp) < 7 * 60_000,
        );
        return <MessageRow key={m.id} message={m} grouped={grouped} />;
      })}
    </div>
  );
}

/** Widget flottant affiché quand l'overlay est réduit (bas-droite). */
function MiniWidget({
  controller,
  onExpand,
}: {
  controller: RemoteController;
  onExpand: () => void;
}): JSX.Element {
  const running = controller.queue.find((q) => q.status === 'in_progress');
  const pct = running && running.channelsTotal > 0
    ? Math.round((running.channelsDone / running.channelsTotal) * 100)
    : 0;
  return (
    <div class="v-mini" onClick={onExpand} title={t('mini.open')}>
      <div class="v-mini-hd">
        <span class="v-logo"><OwlMark class="v-mark" />Vespry</span>
        <span class="v-muted" style="font-size:12px;display:flex;align-items:center">
          {running ? `${pct}%` : <IconExpand />}
        </span>
      </div>
      <div class="v-mini-sub">
        {running
          ? `${running.guildName} · ${running.messages.toLocaleString()} msg`
          : t('mini.no_export')}
      </div>
      {running && (
        <div class="v-bar"><i style={`width:${pct}%`} /></div>
      )}
    </div>
  );
}

/** Panneau Soutiens — don + reconnaissance des soutiens et contributeurs. */
function CreditsPanel({ onBack }: { onBack: () => void }): JSX.Element {
  const [credits, setCredits] = useState<Credits | null>(null);
  useEffect(() => {
    void loadCredits().then(setCredits);
  }, []);

  const supporters = credits?.supporters ?? [];
  const contributors = credits?.contributors ?? [];

  return (
    <div class="v-credits">
      <span class="v-link" onClick={onBack}>{t('credits.back')}</span>
      <div class="v-credits-hd">
        <h2><OwlMark class="v-mark" />{t('credits.title')}</h2>
        <p class="v-intro">{t('credits.intro')}</p>
      </div>
      <div class="v-cred-grid">
        {/* carte Soutiens — appel au don + donateurs */}
        <div class="v-cred-card">
          <h3><IconHeart /> {t('credits.supporters')}</h3>
          {credits?.koFiUrl ? (
            <button
              class="v-donate"
              onClick={() => window.open(credits.koFiUrl, '_blank', 'noopener')}
            >
              <IconHeart /> {t('credits.donate')}
            </button>
          ) : (
            <button class="v-donate" disabled>
              <IconHeart /> {t('credits.donate_soon')}
            </button>
          )}
          {supporters.length > 0 ? (
            <ul class="v-cred-list">
              {supporters.map((s) => (
                <li key={s}>
                  <span class="v-avatar">{s.slice(0, 1).toUpperCase()}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div class="v-cred-empty">{t('credits.none_yet')}</div>
          )}
        </div>
        {/* carte Contributeurs */}
        <div class="v-cred-card">
          <h3>{t('credits.contributors')}</h3>
          {contributors.length > 0 ? (
            <ul class="v-cred-list">
              {contributors.map((c) => (
                <li key={c.name}>
                  <span class="v-avatar">{c.name.slice(0, 1).toUpperCase()}</span>
                  <span>{c.name}</span>
                  <span class="v-role">{c.role}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div class="v-cred-empty">{t('credits.none_yet')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExportQueue({
  controller,
  onSupport,
}: {
  controller: RemoteController;
  onSupport: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { queue } = controller;
  const active = queue.filter((q) => q.status === 'in_progress').length;

  function toggle(id: string): void {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }

  return (
    <div class="v-queue">
      <div class="v-q-hd" onClick={() => setOpen(!open)}>
        {open ? <IconChevronDown /> : <IconChevronRight />}
        {t('queue.title', { n: queue.length, a: active })}
      </div>
      {open && (
        <div class="v-q-body">
          {queue.length === 0 && (
            <span class="v-muted" style="font-size:13px">{t('queue.empty')}</span>
          )}
          {queue.map((item) => (
            <TaskCard
              key={item.runId}
              item={item}
              expanded={expanded.has(item.runId)}
              onToggle={() => toggle(item.runId)}
              onDownload={() => controller.downloadZip(item.runId)}
              onResume={() => controller.resume(item.runId)}
              onSupport={onSupport}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  item,
  expanded,
  onToggle,
  onDownload,
  onResume,
  onSupport,
}: {
  item: QueueItemView;
  expanded: boolean;
  onToggle: () => void;
  onDownload: () => void;
  onResume: () => void;
  onSupport: () => void;
}): JSX.Element {
  const pct = item.channelsTotal > 0
    ? Math.round((item.channelsDone / item.channelsTotal) * 100)
    : 0;
  const done = item.status === 'completed' || item.status === 'partial';

  return (
    <div class="v-task">
      <div class="v-task-main">
        <span class="v-nm">{item.guildName}</span>
        <span class={`v-st v-st--${item.status}`}>{t(`status.${item.status}`)}</span>
        <div class="v-bar">
          <i class={done ? 'ok' : ''} style={`width:${done ? 100 : pct}%`} />
        </div>
        {item.status === 'paused' && (
          <span class="v-exp" onClick={onResume}>{t('queue.resume')}</span>
        )}
        {item.status === 'failed' && (
          <ReportLink
            summary={`Export échoué : ${item.guildName}`}
            log={item.log}
            label={t('report.this')}
          />
        )}
        {done && item.zipReady && (
          <span class="v-exp" onClick={onDownload}>
            <IconDownload />{t('queue.download')}
          </span>
        )}
        <span class="v-exp" onClick={onToggle}>
          {expanded ? t('queue.details_hide') : t('queue.details_show')}
        </span>
      </div>
      {done && (
        <div class="v-thanks" onClick={onSupport}>
          <IconHeart />{t('credits.thanks')}
        </div>
      )}
      {expanded && (
        <div class="v-details">
          <div class="v-stats">
            <Stat n={item.messages} k={t('stat.messages')} />
            <Stat n={item.assetsByKind.image} k={t('stat.images')} />
            <Stat n={item.assetsByKind.video} k={t('stat.videos')} />
            <Stat n={item.assetsByKind.audio} k={t('stat.audio')} />
            <Stat n={item.reactions} k={t('stat.reactions')} />
            <Stat n={item.assetsByKind.file} k={t('stat.files')} />
          </div>
          <div class="v-console">
            {item.log.length === 0 && <div class="ln v-muted">{t('queue.waiting')}</div>}
            {item.log.slice(-60).map((line, i) => (
              <div class="ln" key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Lien « Signaler un problème » — ouvre une issue GitHub pré-remplie. */
function ReportLink({
  summary,
  log,
  label,
}: {
  summary: string;
  log: string[];
  label: string;
}): JSX.Element {
  const [done, setDone] = useState<'' | 'issue' | 'clipboard'>('');
  function go(e: MouseEvent): void {
    e.stopPropagation();
    void reportProblem(summary, log).then((r) => {
      setDone(r);
      setTimeout(() => setDone(''), 3000);
    });
  }
  return (
    <span class="v-link" onClick={go}>
      {done === 'clipboard'
        ? t('report.copied')
        : done === 'issue'
          ? t('report.opened')
          : label}
    </span>
  );
}

function Stat({ n, k }: { n: number; k: string }): JSX.Element {
  return (
    <div class="v-dcell">
      <div class="n">{n.toLocaleString()}</div>
      <div class="k">{k}</div>
    </div>
  );
}
