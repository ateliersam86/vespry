/**
 * Overlay Vespry — UI Preact injectée dans la page Discord (Shadow DOM).
 *
 * Header de confirmation · rail serveurs · liste salons sélectionnable ·
 * personnalisation du salon · file d'export avec détails (stats + console).
 * Toutes les chaînes passent par i18n (`t`).
 */
import { type ComponentChildren, type JSX } from 'preact';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'preact/hooks';
import {
  ALL_FORMATS,
  ALL_MEDIA,
  DEFAULT_FORMATS,
  PARTITION_SIZES,
  messageMatchesZones,
  type ExportFormat,
  type MediaSelection,
  type SelectionZone,
  type ZoneMode,
} from '../../engine/checkpoint-types';

/** Zones-drapeaux : un critère booléen, sans champ de saisie. */
type FlagKind =
  | 'pinned' | 'attachment' | 'image' | 'video'
  | 'audio' | 'sticker' | 'link' | 'embed';

/** Drapeaux proposés, dans l'ordre d'affichage. */
const FLAG_KINDS: FlagKind[] = [
  'pinned', 'attachment', 'image', 'video', 'audio', 'sticker', 'link', 'embed',
];

/** Signature stable d'une zone — clé du jeu des zones inversées. */
function zoneSig(z: SelectionZone): string {
  return z.kind === 'manual' ? `manual:${z.channelId}` : z.kind;
}
import {
  ChannelType,
  type RawAttachment,
  type RawChannel,
  type RawComponent,
  type RawEmbed,
  type RawGuild,
  type RawMessage,
  type RawPoll,
  type RawReaction,
  type RawUser,
} from '../../engine/types';
import type { EnqueueExtras, QueueItemView } from '../../messaging';
import type { RemoteController } from '../../ui/remote-controller';
import { ScheduleSection } from './ScheduleSection';
import { PurgeModal } from './PurgeModal';
import { FilenameTemplateField } from './FilenameTemplateField';
import { PasswordSection } from './PasswordSection';
import {
  DEFAULT_ZIP_TEMPLATE,
  loadZipTemplate,
  renderZipFilename,
} from '../../ui/zip-filename';
import { t } from '../../ui/i18n';
import {
  humanize, renderInlineHtml,
  type MentionLabels, type ResolvedMentions,
} from '../../ui/markdown';
import { getVersion } from '../../version';
import { reportProblem } from '../../diagnostics';
import {
  isSchemaReportEnabled, setSchemaReportEnabled,
} from '../../engine/schema-report';
import { loadCredits, type Credits } from '../../credits';
import type { Donor, DonorFeed } from '../../donors';
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
  IconDownload, IconGitHub, IconSparkle, OwlMark,
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

/** Libellé brut d'une zone (sans le préfixe de négation). */
function zoneCoreLabel(z: SelectionZone, channels: RawChannel[]): string {
  const fmt = (ms?: number): string =>
    ms === undefined ? '…' : new Date(ms).toLocaleDateString('fr-FR');
  switch (z.kind) {
    case 'period': return `${t('zone.period')} ${fmt(z.afterMs)} → ${fmt(z.beforeMs)}`;
    case 'author': return `${t('zone.author')} : ${z.query}`;
    case 'content': return `${t('zone.keyword')} : ${z.query}`;
    case 'mention': return `${t('zone.mention')} : ${z.query}`;
    case 'pinned': return t('zone.pinned');
    case 'attachment': return t('zone.attachment');
    case 'image': return t('zone.image');
    case 'video': return t('zone.video');
    case 'audio': return t('zone.audio');
    case 'sticker': return t('zone.sticker');
    case 'embed': return t('zone.embed');
    case 'link': return t('zone.link');
    case 'manual': {
      const name = channels.find((c) => c.id === z.channelId)?.name ?? '?';
      return t('zone.manual', { n: z.ids.length, channel: name });
    }
  }
}

/** Libellé d'une zone pour le récapitulatif, préfixé « NON » si inversée. */
function zoneLabel(z: SelectionZone, channels: RawChannel[]): string {
  const core = zoneCoreLabel(z, channels);
  return z.negate ? `${t('zone.not')} ${core}` : core;
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
  ChannelType.GUILD_VOICE, // chat texte associé au salon vocal
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

/**
 * Télécharge un zip en appliquant le template de nom de fichier configuré
 * par l'utilisateur (Phase 3). Lecture du template au moment du clic plutôt
 * qu'en amont — l'utilisateur peut l'avoir modifié entre la fin de l'export
 * et le téléchargement. Si la lecture échoue ou que rien n'est défini, on
 * laisse le contrôleur appliquer son défaut historique.
 */
async function downloadWithTemplate(
  controller: RemoteController,
  item: QueueItemView,
): Promise<void> {
  try {
    const stored = await loadZipTemplate(chrome.storage.local);
    const template = stored ?? DEFAULT_ZIP_TEMPLATE;
    const filename = renderZipFilename(template, {
      guildName: item.guildName,
      now: new Date(),
    });
    controller.downloadZip(item.runId, filename);
  } catch {
    // Storage indisponible — on délègue au comportement par défaut.
    controller.downloadZip(item.runId);
  }
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
  const [formats, setFormats] = useState<ExportFormat[]>([...DEFAULT_FORMATS]);
  const [focus, setFocus] = useState<RawChannel | null>(null);
  /** Sélection manuelle de messages, par salon (salonId → ids de messages). */
  const [manualSel, setManualSel] = useState<Map<string, Set<string>>>(new Map());
  /**
   * Modale de purge ouverte (Phase 2). Pointe sur le salon dont la sélection
   * manuelle est en cours de validation. `null` = modale fermée.
   */
  const [purgeTarget, setPurgeTarget] = useState<RawChannel | null>(null);
  const [afterDate, setAfterDate] = useState('');
  const [beforeDate, setBeforeDate] = useState('');
  const [search, setSearch] = useState('');
  const [minimized, setMinimized] = useState(false);
  const [includeThreads, setIncludeThreads] = useState(true);
  // Filtres de contenu.
  const [fContent, setFContent] = useState('');
  const [fAuthor, setFAuthor] = useState('');
  const [fMention, setFMention] = useState('');
  /** Zones-drapeaux actives (pinned, image, sticker…) — un critère sans saisie. */
  const [flags, setFlags] = useState<Set<FlagKind>>(new Set());
  /** Combinaison des zones de critères : OU (`any`) ou ET (`all`). */
  const [zoneMode, setZoneMode] = useState<ZoneMode>('any');
  /** Signatures de zones inversées (NON logique). */
  const [negated, setNegated] = useState<Set<string>>(new Set());
  const [reactionUsers, setReactionUsers] = useState(false);
  /** Export incrémental — seulement les messages depuis le dernier export. */
  const [incremental, setIncremental] = useState(false);
  /** Opt-in à l'envoi de rapports de schéma anonymes (aide la détection). */
  const [schemaOptIn, setSchemaOptIn] = useState(false);
  useEffect(() => {
    void isSchemaReportEnabled().then(setSchemaOptIn);
  }, []);
  /** Découpage des gros salons : messages/fichier (0 = pas de découpage). */
  const [partitionSize, setPartitionSize] = useState(0);
  /**
   * Mot de passe AES-256 du zip (Phase 4 — opt-in). RAM uniquement, jamais
   * persisté. Propagé à `enqueue()` au clic « Ajouter à la file », vidé
   * juste après comme `manualSel` / `selected`.
   */
  const [zipPassword, setZipPassword] = useState('');
  /** Panneau d'export : mode avancé (options pointues visibles) ou simple. */
  const [advanced, setAdvanced] = useState(false);
  const [view, setView] = useState<'export' | 'credits'>('export');
  const [theme, setTheme] = useState<ThemePref>('dark');
  const [credits, setCredits] = useState<Credits | null>(null);
  const [donorFeed, setDonorFeed] = useState<DonorFeed | null>(null);
  const [showSupport, setShowSupport] = useState(false);
  const [celebrate, setCelebrate] = useState(false);

  useEffect(() => {
    void getThemePref().then(setTheme);
    void loadCredits().then(setCredits);
  }, []);

  // Le mur des soutiens se charge dès que le moteur (offscreen) répond — c'est
  // lui qui fait le fetch, la CSP de Discord bloquant l'overlay.
  useEffect(() => {
    if (!controller.ready) return;
    void controller.getDonors().then((f) => {
      if (f) setDonorFeed(f);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.ready]);

  // La page de retour Stripe (popup) prévient l'overlay par postMessage : on
  // ferme la modale, on fête le don (confettis + toast), et on rafraîchit le
  // mur. Double rafraîchissement : le webhook Stripe peut arriver après le
  // postMessage — le second passage rattrape le nouveau soutien.
  useEffect(() => {
    function onMsg(e: MessageEvent): void {
      if (e.data !== 'vespry-donation-ok') return;
      setShowSupport(false);
      setCelebrate(true);
      const refresh = (): void => {
        void controller.getDonors().then((f) => {
          if (f) setDonorFeed(f);
        });
      };
      refresh();
      window.setTimeout(refresh, 4200);
      window.setTimeout(() => setCelebrate(false), 3400);
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [controller]);

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

  /** Bascule la sélection manuelle d'un message dans un salon. */
  function toggleMessage(channelId: string, msgId: string): void {
    const next = new Map(manualSel);
    const set = new Set(next.get(channelId) ?? []);
    if (set.has(msgId)) set.delete(msgId);
    else set.add(msgId);
    if (set.size > 0) next.set(channelId, set);
    else next.delete(channelId);
    setManualSel(next);
  }

  /** Zones de sélection actives — dérivées des filtres + sélection manuelle. */
  const zones = useMemo<SelectionZone[]>(() => {
    const z: SelectionZone[] = [];
    if (afterDate || beforeDate) {
      z.push({
        kind: 'period',
        ...(afterDate ? { afterMs: Date.parse(afterDate) } : {}),
        ...(beforeDate ? { beforeMs: Date.parse(beforeDate) + 86_399_999 } : {}),
      });
    }
    if (fAuthor.trim()) z.push({ kind: 'author', query: fAuthor.trim() });
    if (fContent.trim()) z.push({ kind: 'content', query: fContent.trim() });
    if (fMention.trim()) z.push({ kind: 'mention', query: fMention.trim() });
    for (const f of FLAG_KINDS) if (flags.has(f)) z.push({ kind: f } as SelectionZone);
    for (const [chId, ids] of manualSel) {
      if (ids.size > 0) z.push({ kind: 'manual', channelId: chId, ids: [...ids] });
    }
    // Applique le NON logique aux zones marquées inversées.
    return z.map((zone) =>
      negated.has(zoneSig(zone)) ? { ...zone, negate: true } : zone);
  }, [afterDate, beforeDate, fAuthor, fContent, fMention, flags, manualSel, negated]);

  function selectGuild(guild: RawGuild): void {
    setActiveGuild(guild);
    setChannels([]);
    setSelected(new Set());
    setManualSel(new Map());
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
    // Salons exportés : cochés OU porteurs d'une sélection manuelle.
    const picked = channels.filter(
      (c) => selected.has(c.id) || (manualSel.get(c.id)?.size ?? 0) > 0,
    );
    if (!activeGuild || picked.length === 0) return;
    const extras: EnqueueExtras = {
      includeThreads,
      zones,
      zoneMode,
      partitionSize,
      // Garde-fou : au moins un format, sinon le paquet serait vide.
      formats: formats.length > 0 ? formats : [...DEFAULT_FORMATS],
    };
    if (reactionUsers) extras.includeReactionUsers = true;
    if (incremental) extras.incremental = true;
    if (zipPassword) extras.zipPassword = zipPassword;
    void controller.enqueue(activeGuild, picked, media, extras);
    setSelected(new Set());
    setManualSel(new Map());
    setFocus(null);
    // Sécurité : le mot de passe n'est pas censé survivre à la commande
    // (UN run = UN ciblage). On le vide ; si l'utilisateur enchaîne un
    // second export il devra le retaper.
    setZipPassword('');
  }

  /** Bascule un drapeau de critère (pinned, image, sticker…). */
  function toggleFlag(f: FlagKind): void {
    const next = new Set(flags);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    setFlags(next);
  }

  /** Inverse une zone (NON logique) — basé sur sa signature. */
  function toggleNegate(z: SelectionZone): void {
    const sig = zoneSig(z);
    const next = new Set(negated);
    if (next.has(sig)) next.delete(sig);
    else next.add(sig);
    setNegated(next);
  }

  /** Retire une zone : remet à zéro l'entrée correspondante. */
  function clearZone(z: SelectionZone): void {
    if (z.kind === 'period') { setAfterDate(''); setBeforeDate(''); }
    else if (z.kind === 'author') setFAuthor('');
    else if (z.kind === 'content') setFContent('');
    else if (z.kind === 'mention') setFMention('');
    else if (z.kind === 'manual') {
      const next = new Map(manualSel);
      next.delete(z.channelId);
      setManualSel(next);
    } else {
      // zone-drapeau
      const next = new Set(flags);
      next.delete(z.kind as FlagKind);
      setFlags(next);
    }
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
    <>
    <Shell onClose={onClose} theme={resolvedTheme}>
      {/* header de confirmation */}
      <div class="v-top">
        <span class="v-logo"><OwlMark class="v-mark" />Vespry</span>
        <span style="font-size:11px;color:var(--muted);font-weight:600">v{getVersion()}</span>
        <ReportLink summary="Problème signalé depuis Vespry" log={[]} label={t('report.problem')} />
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
        <CreditsPanel
          onBack={() => setView('export')}
          credits={credits}
          feed={donorFeed}
        />
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
          <MessagePreview
            controller={controller}
            channel={focus}
            zones={zones}
            zoneMode={zoneMode}
            manualIds={(focus && manualSel.get(focus.id)) || undefined}
            onToggleMessage={(id) => focus && toggleMessage(focus.id, id)}
          />
        </div>

        {/* panneau d'export — à droite */}
        <div class="v-side">
          <div class="v-side-hd">
            <span>{t('overlay.settings')}</span>
            <div class="v-modeswitch">
              <span
                class={advanced ? '' : 'on'}
                onClick={() => setAdvanced(false)}
              >
                {t('overlay.mode_simple')}
              </span>
              <span
                class={advanced ? 'on' : ''}
                onClick={() => setAdvanced(true)}
              >
                {t('overlay.mode_advanced')}
              </span>
            </div>
          </div>
          <div class="v-side-body">
            <div class="v-field v-field--zones">
              <label>{t('zones.active')}</label>
              {zones.length === 0 ? (
                <div class="v-hint">{t('zones.empty')}</div>
              ) : (
                <>
                  {zones.filter((z) => z.kind !== 'manual').length >= 2 && (
                    <div class="v-zonemode">
                      <span
                        class={zoneMode === 'any' ? 'on' : ''}
                        onClick={() => setZoneMode('any')}
                      >
                        {t('zones.mode_any')}
                      </span>
                      <span
                        class={zoneMode === 'all' ? 'on' : ''}
                        onClick={() => setZoneMode('all')}
                      >
                        {t('zones.mode_all')}
                      </span>
                    </div>
                  )}
                  <div class="v-zones">
                    {zones.map((z, i) => (
                      <span class={`v-zone ${z.negate ? 'v-zone--neg' : ''}`} key={i}>
                        <span class="v-zone-lbl">{zoneLabel(z, channels)}</span>
                        {z.kind !== 'manual' && (
                          <span
                            class={`v-zone-neg ${z.negate ? 'on' : ''}`}
                            title={t('zones.negate')}
                            onClick={() => toggleNegate(z)}
                          >
                            ≠
                          </span>
                        )}
                        <span
                          class="v-zone-x"
                          title={t('zones.remove')}
                          onClick={() => clearZone(z)}
                        >
                          <IconClose />
                        </span>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
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
              <label>{t('overlay.format_label')}</label>
              <div class="v-mchips">
                {ALL_FORMATS.map((f) => {
                  const on = formats.includes(f);
                  return (
                    <span
                      key={f}
                      class={`v-mchip ${on ? 'on' : ''}`}
                      onClick={() =>
                        setFormats(
                          on
                            ? formats.filter((x) => x !== f)
                            : [...formats, f],
                        )}
                    >
                      {t(`format.${f}`)}
                    </span>
                  );
                })}
              </div>
            </div>
            {advanced && (
            <>
            <div class="v-field">
              <label>{t('overlay.partition_label')}</label>
              <div class="v-mchips">
                {PARTITION_SIZES.map((size) => (
                  <span
                    key={size}
                    class={`v-mchip ${partitionSize === size ? 'on' : ''}`}
                    onClick={() => setPartitionSize(size)}
                  >
                    {size === 0
                      ? t('partition.none')
                      : t('partition.size', { n: size.toLocaleString() })}
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
              <div class="v-mchips">
                {FLAG_KINDS.map((f) => (
                  <span
                    key={f}
                    class={`v-mchip ${flags.has(f) ? 'on' : ''}`}
                    onClick={() => toggleFlag(f)}
                  >
                    {t(`zone.${f}`)}
                  </span>
                ))}
              </div>
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
              <CheckRow
                on={incremental}
                onToggle={() => setIncremental(!incremental)}
                label={t('filter.incremental')}
              />
              <CheckRow
                on={schemaOptIn}
                onToggle={() => {
                  const next = !schemaOptIn;
                  setSchemaOptIn(next);
                  void setSchemaReportEnabled(next);
                }}
                label={t('filter.schema_optin')}
              />
            </div>
            {focus && activeGuild && (manualSel.get(focus.id)?.size ?? 0) > 0 && (
              <div class="v-field">
                <label>{t('purge.section')}</label>
                <button
                  class="v-btn v-btn-danger"
                  onClick={() => setPurgeTarget(focus)}
                >
                  {t('purge.button', {
                    n: String(manualSel.get(focus.id)?.size ?? 0),
                  })}
                </button>
                <div class="v-help">{t('purge.section_help')}</div>
              </div>
            )}
            <FilenameTemplateField activeGuild={activeGuild} />
            <ScheduleSection guilds={controller.guilds} />
            <PasswordSection password={zipPassword} onChange={setZipPassword} />
            </>
            )}
          </div>
          <div class="v-side-foot">
            <button
              class="v-btn"
              disabled={selected.size === 0 && manualSel.size === 0}
              onClick={enqueue}
            >
              {t('overlay.add_to_queue')}
            </button>
          </div>
        </div>
      </div>

      <ExportQueue controller={controller} onSupport={() => setShowSupport(true)} />
      <DonorWall
        feed={donorFeed}
        credits={credits}
        onSupport={() => setShowSupport(true)}
      />
      </>
      )}
    </Shell>
    {showSupport && credits && (
      <SupportModal
        controller={controller}
        credits={credits}
        theme={resolvedTheme}
        onClose={() => setShowSupport(false)}
        onWall={() => {
          setShowSupport(false);
          setView('credits');
        }}
      />
    )}
    {celebrate && (
      <div class="v-root" data-theme={resolvedTheme}>
        <Confetti />
        <Toast text={t('wall.thank_toast')} />
      </div>
    )}
    {purgeTarget && activeGuild && (
      <div class="v-root" data-theme={resolvedTheme}>
        <PurgeModal
          controller={controller}
          guild={activeGuild}
          channel={purgeTarget}
          messageIds={[...(manualSel.get(purgeTarget.id) ?? new Set<string>())]}
          onClose={() => setPurgeTarget(null)}
          onConfirmed={() => {
            // Vide la sélection manuelle pour le salon ciblé — éviter de
            // re-cibler des messages que la purge va supprimer.
            const next = new Map(manualSel);
            next.delete(purgeTarget.id);
            setManualSel(next);
          }}
        />
      </div>
    )}
    </>
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
          {Array.from({ length: 12 }, (_, i) => <i key={i} />)}
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

/** Étiquettes de mentions Discord, traduites dans la langue de l'utilisateur. */
const MENTIONS: MentionLabels = {
  user: t('mention.user'),
  role: t('mention.role'),
  channel: t('mention.channel'),
};

/** Texte brut humanisé — pour les zones où on ne veut pas de HTML (embed desc courte). */
function cleanContent(text: string): string {
  return humanize(text, MENTIONS);
}

/** Construit la table des mentions résolues à partir de `message.mentions[]`. */
function resolvedFor(message: RawMessage): ResolvedMentions {
  const users: Record<string, string> = {};
  for (const u of message.mentions ?? []) {
    users[u.id] = u.global_name ?? u.username;
  }
  return { users };
}

/** Classe une pièce jointe par type, d'après son content-type ou extension. */
function attKind(a: RawAttachment): 'image' | 'audio' | 'video' | 'file' {
  const ct = a.content_type ?? '';
  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)(\?|$)/i.test(a.url)) {
    return 'image';
  }
  if (ct.startsWith('audio/') || /\.(mp3|ogg|oga|wav|m4a|flac|opus)(\?|$)/i.test(a.url)) {
    return 'audio';
  }
  if (ct.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i.test(a.url)) {
    return 'video';
  }
  return 'file';
}

/** Une pièce jointe : image, lecteur audio, lecteur vidéo, ou puce fichier. */
function Attachment({ att }: { att: RawAttachment }): JSX.Element {
  const url = att.proxy_url || att.url;
  switch (attKind(att)) {
    case 'image':
      return <img class="v-msg-img" src={url} alt={att.filename} loading="lazy" />;
    case 'audio':
      return (
        <div class="v-msg-audio">
          <span class="v-msg-fname">{att.filename}</span>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls preload="none" src={url} />
        </div>
      );
    case 'video':
      // eslint-disable-next-line jsx-a11y/media-has-caption
      return <video class="v-msg-video" controls preload="metadata" src={url} />;
    default:
      return <span class="v-msg-file">{att.filename}</span>;
  }
}

/** Stickers affichables d'un message (PNG/APNG/GIF — Lottie ignoré). */
function stickerImages(m: RawMessage): { id: string; name: string; url: string }[] {
  return (m.sticker_items ?? [])
    .filter((s) => s.format_type !== 3)
    .map((s) => ({
      id: s.id,
      name: s.name,
      url: `https://media.discordapp.net/stickers/${s.id}.${s.format_type === 4 ? 'gif' : 'png'}`,
    }));
}

/** Embeds porteurs de contenu (on ignore les embeds vides / techniques). */
function cardEmbeds(m: RawMessage): RawEmbed[] {
  return m.embeds.filter(
    (e) => e.title || e.description || e.image?.url || e.thumbnail?.url,
  );
}

/** Carte d'embed simplifiée — barre de couleur, titre, description, image. */
function EmbedCard({ embed }: { embed: RawEmbed }): JSX.Element {
  const img = embed.image?.url ?? embed.thumbnail?.url;
  const accent = typeof embed.color === 'number'
    ? `#${embed.color.toString(16).padStart(6, '0')}`
    : 'var(--accent)';
  return (
    <div class="v-msg-embed" style={`border-left-color:${accent}`}>
      {embed.author?.name && <div class="v-embed-author">{embed.author.name}</div>}
      {embed.title && <div class="v-embed-title">{embed.title}</div>}
      {embed.description && (
        <div
          class="v-embed-desc"
          dangerouslySetInnerHTML={{
            __html: renderInlineHtml(embed.description, MENTIONS),
          }}
        />
      )}
      {img && <img class="v-embed-img" src={img} alt="" loading="lazy" />}
    </div>
  );
}

/** Aplatit récursivement les composants — boutons et menus utiles. */
function flatComponents(components: RawComponent[]): RawComponent[] {
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

/** Composants Discord (boutons, menus) — rendu visuel non interactif. */
function Components({ components }: { components: RawComponent[] }): JSX.Element | null {
  const flat = flatComponents(components);
  if (flat.length === 0) return null;
  return (
    <div class="v-components">
      {flat.map((c, i) => {
        if (c.type === 2) {
          const label = (c.emoji?.name ? `${c.emoji.name} ` : '') + (c.label ?? '—');
          if (c.style === 5 && c.url) {
            return (
              <a key={i} class="v-comp-btn link" href={c.url} target="_blank" rel="noopener">
                {label}
              </a>
            );
          }
          return (
            <span key={i} class={`v-comp-btn ${c.disabled ? 'disabled' : ''}`}>
              {label}
            </span>
          );
        }
        return (
          <span key={i} class="v-comp-menu-label">▾ {c.placeholder ?? '—'}</span>
        );
      })}
    </div>
  );
}

/** Sondage Discord — titre, options, votes. */
function Poll({ poll }: { poll: RawPoll }): JSX.Element {
  const counts = new Map<number, number>();
  for (const c of poll.results?.answer_counts ?? []) counts.set(c.id, c.count);
  return (
    <div class="v-poll">
      <div class="v-poll-title">[{t('exp.poll')}]</div>
      <div class="v-poll-question">{poll.question.text ?? ''}</div>
      <ul class="v-poll-answers">
        {poll.answers.map((a) => {
          const c = counts.get(a.answer_id);
          return (
            <li key={a.answer_id}>
              {a.poll_media.emoji?.name && (
                <span class="v-poll-emoji">{a.poll_media.emoji.name} </span>
              )}
              {a.poll_media.text}
              {c !== undefined && (
                <span class="v-poll-votes"> · {t('exp.poll_votes', { n: c })}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Bandeau des réactions d'un message (emoji + compteur). */
function Reactions({ reactions }: { reactions: RawReaction[] }): JSX.Element {
  return (
    <div class="v-msg-reactions">
      {reactions.map((r, i) => (
        <span class="v-react" key={i}>
          {r.emoji.id
            ? (
              <img
                class="v-react-emoji"
                src={`https://cdn.discordapp.com/emojis/${r.emoji.id}.${r.emoji.animated ? 'gif' : 'png'}`}
                alt={r.emoji.name ?? ''}
                loading="lazy"
              />
            )
            : <span class="v-react-uni">{r.emoji.name}</span>}
          <span class="v-react-count">{r.count}</span>
        </span>
      ))}
    </div>
  );
}

/** Une ligne de message dans l'aperçu (groupée = même auteur enchaîné). */
function MessageRow({
  message,
  grouped,
  index,
  highlighted,
  checked,
  onToggle,
}: {
  message: RawMessage;
  grouped: boolean;
  index: number;
  /** Couvert par une zone de sélection → surligné. */
  highlighted: boolean;
  /** Coché manuellement. */
  checked: boolean;
  onToggle: () => void;
}): JSX.Element {
  const m = message;
  const name = m.author.global_name ?? m.author.username;
  const stickers = stickerImages(m);
  const embeds = cardEmbeds(m);
  return (
    <div
      class={`v-msg ${grouped ? 'v-msg--grouped' : ''} ${highlighted ? 'v-msg--on' : ''}`}
      style={`animation-delay:${Math.min(index, 18) * 22}ms`}
      onClick={onToggle}
    >
      <span class={`v-cbx v-msg-cbx ${checked ? 'on' : ''}`}>
        {checked ? <IconCheck /> : null}
      </span>
      {grouped
        ? <div class="v-msg-gutter" />
        : <img class="v-msg-avatar" src={avatarUrl(m.author)} alt="" loading="lazy" />}
      <div class="v-msg-main">
        {m.referenced_message && (() => {
          const forwarded = m.message_reference?.type === 1;
          return (
            <div class={`v-msg-reply ${forwarded ? 'v-msg-reply--fwd' : ''}`}>
              <span class="v-msg-reply-arrow">{forwarded ? '↗' : '↪'}</span>
              <span class="v-msg-reply-author">
                {m.referenced_message.author.global_name
                  ?? m.referenced_message.author.username}
              </span>
              <span class="v-msg-reply-text">
                {cleanContent(m.referenced_message.content).slice(0, 120)}
              </span>
            </div>
          );
        })()}
        {!grouped && (
          <div class="v-msg-head">
            <span class="v-msg-author">{name}</span>
            {m.pinned && <span class="v-msg-pin">{t('zone.pinned')}</span>}
            <span class="v-msg-time">{formatTime(m.timestamp)}</span>
            {m.edited_timestamp && (
              <span class="v-msg-edited">({t('exp.edited')})</span>
            )}
          </div>
        )}
        {m.content && (
          <div
            class="v-msg-content"
            dangerouslySetInnerHTML={{
              __html: renderInlineHtml(m.content, MENTIONS, resolvedFor(m))
                // marqueur édité visible aussi quand le message est groupé
                + (grouped && m.edited_timestamp
                  ? ` <span class="v-msg-edited">(${t('exp.edited')})</span>`
                  : ''),
            }}
          />
        )}
        {!m.content && grouped && m.edited_timestamp && (
          <span class="v-msg-edited">({t('exp.edited')})</span>
        )}
        {m.attachments.length > 0 && (
          <div class="v-msg-atts">
            {m.attachments.map((a) => <Attachment key={a.id} att={a} />)}
          </div>
        )}
        {stickers.length > 0 && (
          <div class="v-msg-atts">
            {stickers.map((s) => (
              <img key={s.id} class="v-msg-sticker" src={s.url} alt={s.name} loading="lazy" />
            ))}
          </div>
        )}
        {embeds.map((e, i) => <EmbedCard key={i} embed={e} />)}
        {m.poll && <Poll poll={m.poll} />}
        {m.components && <Components components={m.components} />}
        {m.reactions && m.reactions.length > 0 && <Reactions reactions={m.reactions} />}
      </div>
    </div>
  );
}

/**
 * Aperçu des messages d'un salon — affichage façon Discord, défilement
 * infini de l'historique, surlignage des messages couverts par une zone,
 * cases à cocher pour la sélection manuelle.
 */
function MessagePreview({
  controller,
  channel,
  zones,
  zoneMode,
  manualIds,
  onToggleMessage,
}: {
  controller: RemoteController;
  channel: RawChannel | null;
  zones: SelectionZone[];
  zoneMode: ZoneMode;
  manualIds: Set<string> | undefined;
  onToggleMessage: (id: string) => void;
}): JSX.Element {
  const [messages, setMessages] = useState<RawMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const prependFrom = useRef<number | null>(null);
  const toBottom = useRef(false);

  // (re)charge l'aperçu au changement de salon.
  useEffect(() => {
    if (!channel) { setMessages([]); setDone(false); return undefined; }
    let cancelled = false;
    setMessages([]); setDone(false); setLoading(true);
    void controller.preview(channel.id).then((raw) => {
      if (cancelled) return;
      // API : récent → ancien ; affichage : ancien → récent.
      setMessages(raw.slice().reverse());
      setDone(raw.length < 100);
      setLoading(false);
      toBottom.current = true;
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id]);

  // Après chargement initial → défile en bas ; après un prepend → conserve
  // la position visuelle (sinon la vue sauterait).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (toBottom.current) {
      el.scrollTop = el.scrollHeight;
      toBottom.current = false;
    } else if (prependFrom.current !== null) {
      el.scrollTop += el.scrollHeight - prependFrom.current;
      prependFrom.current = null;
    }
  });

  function loadOlder(): void {
    const el = listRef.current;
    const oldest = messages[0];
    if (!channel || loadingMore || done || !oldest) return;
    setLoadingMore(true);
    void controller.preview(channel.id, oldest.id).then((raw) => {
      if (el) prependFrom.current = el.scrollHeight;
      setMessages((cur) => [...raw.slice().reverse(), ...cur]);
      setDone(raw.length < 100);
      setLoadingMore(false);
    });
  }

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
  const picked = manualIds ?? new Set<string>();
  return (
    <div
      class="v-msglist"
      ref={listRef}
      onScroll={(e) => {
        if ((e.target as HTMLElement).scrollTop < 120) loadOlder();
      }}
    >
      {loadingMore && <div class="v-msg-more">{t('overlay.loading')}</div>}
      {done && <div class="v-msg-more">{t('preview.start')}</div>}
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const grouped = Boolean(
          prev
          && prev.author.id === m.author.id
          && Date.parse(m.timestamp) - Date.parse(prev.timestamp) < 7 * 60_000,
        );
        return (
          <MessageRow
            key={m.id}
            message={m}
            grouped={grouped}
            index={i}
            highlighted={
              zones.length > 0
              && messageMatchesZones(m, zones, channel.id, zoneMode)
            }
            checked={picked.has(m.id)}
            onToggle={() => onToggleMessage(m.id)}
          />
        );
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

/** Anime un entier 0 → `target` en ~900 ms (ease-out cubique). */
function useCountUp(target: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target <= 0) {
      setValue(0);
      return undefined;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - start) / 900);
      setValue(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
}

/** Phrase d'accroche du prochain palier — le moteur de motivation. */
function nextMilestoneLine(feed: DonorFeed): string {
  const nm = feed.nextMilestone;
  if (!nm) return t('wall.next_done');
  const tier = t(nm.key);
  return nm.remaining <= 1
    ? t('wall.next_one', { tier })
    : t('wall.next', { n: nm.remaining, tier });
}

/** Une puce du bandeau défilant — remerciement simple ou palier décroché. */
function DonorChip({ donor }: { donor: Donor }): JSX.Element {
  const who = donor.name ?? t('wall.thanks_anon');
  if (donor.milestone) {
    return (
      <span class="v-chip v-chip--ms" title={t(donor.milestone)}>
        <IconSparkle class="v-chip-spark" />
        <span class="v-chip-name">
          {t('wall.milestone', { name: who, tier: t(donor.milestone) })}
        </span>
      </span>
    );
  }
  return (
    <span class="v-chip">
      <span class="v-chip-av">{who.slice(0, 1).toUpperCase()}</span>
      <span class="v-chip-name">
        {donor.name ? t('wall.thanks', { name: donor.name }) : t('wall.thanks_anon')}
      </span>
      {donor.message && <span class="v-chip-msg">“{donor.message}”</span>}
    </span>
  );
}

/** Couleurs des confettis — palette crépuscule. */
const CONFETTI_COLORS = ['#6c5ce0', '#ec6a93', '#8b7be8', '#f0b54a', '#b3a6e6'];

/** Cycle entre plusieurs lignes toutes les ~5 s. Une seule ligne → pas de cycle. */
function useRotatingLine(lines: string[]): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (lines.length <= 1) return undefined;
    const id = window.setInterval(
      () => setI((n) => (n + 1) % lines.length),
      5200,
    );
    return () => window.clearInterval(id);
  }, [lines.length]);
  return lines[i % Math.max(1, lines.length)] ?? '';
}

/** Date relative courte et lisible. */
function relativeTime(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return t('wall.today');
  if (days === 1) return t('wall.yesterday');
  return t('wall.days_ago', { n: days });
}

/**
 * Lignes de motivation du footer — UNIQUEMENT des affirmations vraies pour
 * l'état courant. La ligne de momentum n'entre dans le cycle que s'il y a
 * réellement eu de l'activité : jamais « 0 soutien cette semaine ».
 */
function motivationLines(feed: DonorFeed): string[] {
  const lines: string[] = [nextMilestoneLine(feed)];
  if (feed.nextMilestone) {
    lines.push(t('wall.you_could', { n: feed.nextMilestone.seq }));
  }
  if (feed.weekCount >= 1) {
    lines.push(
      feed.weekCount === 1
        ? t('wall.week_one')
        : t('wall.week', { n: feed.weekCount }),
    );
  } else {
    const last = feed.recent[0];
    if (last && Date.now() - last.createdAt < 30 * 86_400_000) {
      lines.push(t('wall.last', { when: relativeTime(last.createdAt) }));
    }
  }
  return lines;
}

/** Pluie de confettis crépuscule — célèbre un don. Inhibée si reduce-motion. */
function Confetti(): JSX.Element | null {
  const pieces = useMemo(
    () =>
      Array.from({ length: 38 }, () => ({
        left: Math.random() * 100,
        bg:
          CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]
          ?? '#6c5ce0',
        delay: Math.random() * 0.5,
        dur: 1.9 + Math.random() * 1.5,
        rot: Math.round(Math.random() * 720 - 360),
      })),
    [],
  );
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  return (
    <div class="v-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i
          key={i}
          style={`left:${p.left}%;background:${p.bg};animation-delay:${p.delay}s;animation-duration:${p.dur}s;--r:${p.rot}deg`}
        />
      ))}
    </div>
  );
}

/** Toast de remerciement, en bas de l'écran. */
function Toast({ text }: { text: string }): JSX.Element {
  return (
    <div class="v-toast">
      <IconHeart /> {text}
    </div>
  );
}

/**
 * Footer « Mur des soutiens » — pleine largeur, bas de fenêtre.
 *
 * Barre de progression vers le prochain palier, compteur animé, bandeau
 * défilant des remerciements, ligne de motivation rotative (toujours
 * cohérente avec l'état réel), bouton de soutien.
 */
function DonorWall({
  feed,
  credits,
  onSupport,
}: {
  feed: DonorFeed | null;
  credits: Credits | null;
  onSupport: () => void;
}): JSX.Element {
  const total = feed?.total ?? 0;
  const recent = feed?.recent ?? [];
  const shown = useCountUp(total);
  const line = useRotatingLine(feed && total > 0 ? motivationLines(feed) : []);
  const canDonate = Boolean(
    credits
    && (credits.donorApiUrl || credits.koFiUrl || credits.gitHubSponsorsUrl),
  );
  const nm = feed?.nextMilestone ?? null;
  const progressPct = nm ? Math.min(100, (total / nm.seq) * 100) : 100;

  return (
    <div class="v-wall">
      {feed && (
        <div
          class="v-wall-progress"
          style={`width:${progressPct}%`}
          aria-hidden="true"
        />
      )}
      <div class="v-wall-count">
        <OwlMark class="v-mark" />
        {total > 0 ? (
          <span class="v-wall-num">
            <b>{shown.toLocaleString()}</b>{' '}
            {total === 1 ? t('wall.supporter_one') : t('wall.supporters')}
          </span>
        ) : (
          <span class="v-wall-tag">{t('wall.tagline')}</span>
        )}
      </div>

      <div class="v-wall-stream">
        {recent.length > 0 ? (
          <div class="v-ticker">
            <div class="v-ticker-track">
              {recent.map((d, i) => <DonorChip key={`a${i}`} donor={d} />)}
              {recent.map((d, i) => <DonorChip key={`b${i}`} donor={d} />)}
            </div>
          </div>
        ) : (
          <span class="v-wall-hook">
            <IconSparkle class="v-wall-hook-ico" /> {t('wall.first_hook')}
          </span>
        )}
      </div>

      <div class="v-wall-aside">
        {line && <span class="v-wall-next">{line}</span>}
        <button
          class="v-wall-cta"
          onClick={onSupport}
          disabled={!canDonate}
          title={t('wall.cta')}
        >
          <IconHeart /> {t('wall.cta')}
        </button>
      </div>
    </div>
  );
}

/** Montants prédéfinis du don — étiquettes thématiques crépuscule/hibou. */
const SUPPORT_PRESETS: { cents: number; key: string }[] = [
  { cents: 300, key: 'support.tier_s' },
  { cents: 500, key: 'support.tier_m' },
  { cents: 1000, key: 'support.tier_l' },
];

const MIN_DON_CENTS = 100;
const MAX_DON_CENTS = 100_000;

/** Formate un montant en centimes vers un libellé euros court. */
function euros(cents: number): string {
  return (cents / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

/**
 * Modale de soutien — montant, identité optionnelle, puis ouverture de la
 * popup Stripe Checkout. Rendue dans son propre `.v-root` (au-dessus de
 * l'overlay) pour échapper au `overflow:hidden` de la fenêtre.
 */
function SupportModal({
  controller,
  credits,
  theme,
  onClose,
  onWall,
}: {
  controller: RemoteController;
  credits: Credits;
  theme: 'dark' | 'light';
  onClose: () => void;
  onWall: () => void;
}): JSX.Element {
  const [amountCents, setAmountCents] = useState(500);
  const [customEur, setCustomEur] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState<'' | 'pending' | 'error'>('');

  const configured = Boolean(credits.donorApiUrl);
  const validAmount = amountCents >= MIN_DON_CENTS && amountCents <= MAX_DON_CENTS;

  function onCustom(value: string): void {
    setCustomEur(value);
    const eur = Number(value.replace(',', '.'));
    if (Number.isFinite(eur) && eur > 0) setAmountCents(Math.round(eur * 100));
  }

  function donate(): void {
    if (!configured || !validAmount || status === 'pending') return;
    // La popup s'ouvre TOUT DE SUITE, sur le geste utilisateur : après le
    // round-trip de messaging, le navigateur la bloquerait.
    const popup = window.open(
      'about:blank',
      'vespry-pay',
      'width=460,height=720,menubar=no,toolbar=no,location=yes',
    );
    setStatus('pending');
    void controller
      .startCheckout({
        amountCents,
        donorName: isPublic ? name.trim() || null : null,
        message: isPublic ? msg.trim() || null : null,
        isPublic,
      })
      .then((url) => {
        if (url) {
          if (popup) popup.location.href = url;
          else window.open(url, 'vespry-pay');
          setStatus('');
        } else {
          popup?.close();
          setStatus('error');
        }
      });
  }

  return (
    <div class="v-root" data-theme={theme}>
      <div
        class="v-modal-bd"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div class="v-modal">
          <div class="v-modal-hd">
            <span class="v-logo"><OwlMark class="v-mark" />{t('support.title')}</span>
            <span class="v-close" onClick={onClose} title={t('overlay.close')}>
              <IconClose />
            </span>
          </div>
          <p class="v-modal-intro">{t('support.intro')}</p>

          <div class="v-amts">
            {SUPPORT_PRESETS.map((p) => (
              <button
                key={p.cents}
                class={`v-amt ${amountCents === p.cents && !customEur ? 'on' : ''}`}
                onClick={() => {
                  setAmountCents(p.cents);
                  setCustomEur('');
                }}
              >
                <b>{euros(p.cents)} €</b>
                <span>{t(p.key)}</span>
              </button>
            ))}
          </div>
          <div class="v-amt-custom">
            <input
              class="v-input"
              type="number"
              min="1"
              max="1000"
              placeholder={t('support.custom')}
              value={customEur}
              onInput={(e) => onCustom((e.target as HTMLInputElement).value)}
            />
            <span class="v-muted">€</span>
          </div>

          <CheckRow
            on={isPublic}
            onToggle={() => setIsPublic(!isPublic)}
            label={t('support.show_name')}
          />
          {isPublic && (
            <div class="v-filter-inputs">
              <input
                class="v-input"
                type="text"
                maxLength={48}
                placeholder={t('support.name_ph')}
                value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
              <input
                class="v-input"
                type="text"
                maxLength={280}
                placeholder={t('support.msg_ph')}
                value={msg}
                onInput={(e) => setMsg((e.target as HTMLInputElement).value)}
              />
            </div>
          )}

          <button
            class="v-btn v-modal-pay"
            disabled={!configured || !validAmount || status === 'pending'}
            onClick={donate}
          >
            {status === 'pending'
              ? t('support.processing')
              : configured
                ? t('support.pay', { amount: `${euros(amountCents)} €` })
                : t('credits.donate_soon')}
          </button>
          {status === 'error' && (
            <div class="v-modal-err">{t('support.error')}</div>
          )}
          <div class="v-modal-secured">
            <IconHeart /> {t('support.secured')}
          </div>

          {(credits.koFiUrl || credits.gitHubSponsorsUrl) && (
            <div class="v-modal-alt">
              <span class="v-muted">{t('support.or')}</span>
              {credits.koFiUrl && (
                <span
                  class="v-link"
                  onClick={() => window.open(credits.koFiUrl, '_blank', 'noopener')}
                >
                  Ko-fi
                </span>
              )}
              {credits.gitHubSponsorsUrl && (
                <span
                  class="v-link"
                  onClick={() =>
                    window.open(credits.gitHubSponsorsUrl, '_blank', 'noopener')
                  }
                >
                  <IconGitHub /> GitHub Sponsors
                </span>
              )}
            </div>
          )}
          <span class="v-link v-modal-wall" onClick={onWall}>
            {t('support.wall_link')}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Bouton de don vers une plateforme — désactivé si l'URL n'est pas configurée. */
function DonateButton({
  url,
  icon,
  label,
}: {
  url: string | undefined;
  icon: JSX.Element;
  label: string;
}): JSX.Element {
  if (!url) {
    return (
      <button class="v-donate" disabled>
        {icon} {t('credits.donate_soon')}
      </button>
    );
  }
  return (
    <button class="v-donate" onClick={() => window.open(url, '_blank', 'noopener')}>
      {icon} {label}
    </button>
  );
}

/** Panneau Soutiens — appel au don, mur des soutiens complet, contributeurs. */
function CreditsPanel({
  onBack,
  credits,
  feed,
}: {
  onBack: () => void;
  credits: Credits | null;
  feed: DonorFeed | null;
}): JSX.Element {
  const contributors = credits?.contributors ?? [];
  const recent = feed?.recent ?? [];
  const total = feed?.total ?? 0;

  return (
    <div class="v-credits">
      <span class="v-link" onClick={onBack}>{t('credits.back')}</span>
      <div class="v-credits-hd">
        <h2><OwlMark class="v-mark" />{t('credits.title')}</h2>
        <p class="v-intro">{t('credits.intro')}</p>
      </div>
      <div class="v-donate-row">
        <DonateButton
          url={credits?.koFiUrl}
          icon={<IconHeart />}
          label={t('credits.kofi')}
        />
        <DonateButton
          url={credits?.gitHubSponsorsUrl}
          icon={<IconGitHub />}
          label={t('credits.github')}
        />
      </div>
      <div class="v-cred-grid">
        {/* carte Mur des soutiens */}
        <div class="v-cred-card">
          <h3><IconHeart /> {t('credits.wall_title')}</h3>
          {total > 0 && (
            <div class="v-cred-total">{t('credits.total', { n: total })}</div>
          )}
          {recent.length > 0 ? (
            <ul class="v-cred-list">
              {recent.map((d) => (
                <li key={d.seq} class={d.milestone ? 'v-cred-ms' : ''}>
                  <span class="v-avatar">
                    {d.milestone
                      ? <IconSparkle />
                      : (d.name ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span class="v-cred-who">
                    {d.name ?? t('wall.thanks_anon')}
                    {d.message && <span class="v-cred-msg">“{d.message}”</span>}
                  </span>
                  {d.milestone && <span class="v-role">{t(d.milestone)}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <div class="v-cred-empty">{t('credits.no_donors')}</div>
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
                  <span class="v-cred-who">{c.name}</span>
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
              onDownload={() => void downloadWithTemplate(controller, item)}
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
