/**
 * Section « Planifier un export » du mode Avancé (Phase 3).
 *
 * Permet à l'utilisateur de programmer un export incrémental récurrent d'un
 * serveur — quotidien ou hebdomadaire, à une heure UTC fixe. L'état est
 * persisté dans `chrome.storage.local` (clé `vespry.scheduled`). Le service
 * worker écoute cette clé et installe / désinstalle `chrome.alarms`
 * automatiquement.
 *
 * UN seul planning actif à la fois (simplicité V1). Pour planifier un autre
 * serveur, l'utilisateur change la sélection — l'ancien est remplacé.
 *
 * Composant isolé dans son propre fichier (et non inliné dans Overlay.tsx)
 * pour éviter les conflits de merge avec les autres chantiers Phase 2/3 qui
 * touchent le mode Avancé en parallèle.
 */
import { useEffect, useState } from 'preact/hooks';
import {
  loadSchedule,
  saveSchedule,
  type ScheduleFrequency,
  type ScheduledExport,
} from '../../engine/scheduler';
import { t } from '../../ui/i18n';
import type { RawGuild } from '../../engine/types';

interface Props {
  /** Serveurs connus (issus de `RemoteController.guilds`). */
  guilds: RawGuild[];
}

/** Bornes locales d'affichage : heure UTC 0..23. */
const UTC_HOURS = Array.from({ length: 24 }, (_, h) => h);

export function ScheduleSection({ guilds }: Props): preact.JSX.Element {
  // État édité localement, sauvegardé sur action utilisateur — pas de write
  // au storage à chaque keystroke (évite les loops d'`onChanged` côté SW).
  const [frequency, setFrequency] = useState<ScheduleFrequency | 'none'>('none');
  const [guildId, setGuildId] = useState<string>('');
  const [hourUtc, setHourUtc] = useState<number>(3);
  const [saved, setSaved] = useState<ScheduledExport | null>(null);
  const [busy, setBusy] = useState(false);

  // Hydrate depuis storage au montage. Si une config existe, on reflète son
  // état pour que l'utilisateur voie ce qui est actif (et puisse modifier).
  useEffect(() => {
    void loadSchedule(chrome.storage.local).then((s) => {
      if (s) {
        setSaved(s);
        setFrequency(s.frequency);
        setGuildId(s.guildId);
        setHourUtc(s.hourUtc);
      }
    });
  }, []);

  const canSave = frequency === 'none' || (guildId.length > 0 && guilds.some((g) => g.id === guildId));

  async function onSave(): Promise<void> {
    setBusy(true);
    try {
      if (frequency === 'none') {
        await saveSchedule(chrome.storage.local, null);
        setSaved(null);
        return;
      }
      const guild = guilds.find((g) => g.id === guildId);
      if (!guild) return;
      const next: ScheduledExport = {
        guildId: guild.id,
        guildName: guild.name,
        frequency,
        hourUtc,
      };
      await saveSchedule(chrome.storage.local, next);
      setSaved(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="v-field">
      <label>{t('schedule.label')}</label>
      <div class="v-mchips">
        {(['none', 'daily', 'weekly'] as const).map((f) => (
          <span
            key={f}
            class={`v-mchip ${frequency === f ? 'on' : ''}`}
            onClick={() => setFrequency(f)}
          >
            {f === 'none'
              ? t('schedule.frequency_none')
              : f === 'daily'
                ? t('schedule.frequency_daily')
                : t('schedule.frequency_weekly')}
          </span>
        ))}
      </div>

      {frequency !== 'none' && (
        <div class="v-filter-inputs">
          <select
            class="v-input"
            value={guildId}
            onChange={(e) => setGuildId((e.target as HTMLSelectElement).value)}
          >
            <option value="">{t('schedule.choose_server')}</option>
            {guilds.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select
            class="v-input"
            value={String(hourUtc)}
            onChange={(e) => setHourUtc(Number((e.target as HTMLSelectElement).value))}
          >
            {UTC_HOURS.map((h) => (
              <option key={h} value={String(h)}>
                {t('schedule.hour', { h: String(h).padStart(2, '0') })}
              </option>
            ))}
          </select>
        </div>
      )}

      <div class="v-mchips">
        <span
          class={`v-mchip ${canSave && !busy ? 'on' : ''}`}
          onClick={canSave && !busy ? () => void onSave() : undefined}
        >
          {busy ? '…' : t('schedule.save')}
        </span>
        {saved && (
          <span class="v-mchip" style="opacity:.7">
            {t('schedule.current', {
              guild: saved.guildName,
              freq:
                saved.frequency === 'daily'
                  ? t('schedule.frequency_daily')
                  : t('schedule.frequency_weekly'),
              hour: String(saved.hourUtc).padStart(2, '0'),
            })}
          </span>
        )}
      </div>
    </div>
  );
}
