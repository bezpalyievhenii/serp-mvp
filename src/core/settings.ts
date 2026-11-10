import { Cron } from 'croner';
import type { Store } from './ports';
import { parseSettings, settingRows } from './repo';
import { SHEET_KEYS } from './schema';
import type { Settings } from './types';

export async function getSettings(store: Store): Promise<Settings> {
  return parseSettings((await store.readMany(['Settings'])).Settings);
}

/** Проверяет cron-выражение и возвращает ближайшие запуски (для подсказки в интерфейсе). */
export function describeCron(expr: string, timezone: string, count = 3): { valid: boolean; next: string[]; error?: string } {
  try {
    const job = new Cron(expr, { timezone, paused: true });
    const next = job.nextRuns(count).map((d) => d.toISOString());
    job.stop();
    return { valid: true, next };
  } catch (e) {
    return { valid: false, next: [], error: (e as Error).message };
  }
}

export class SettingsError extends Error {}

/** Меняет cron и/или включатель автозапуска. Включить можно только с корректным cron. */
export async function setSchedule(store: Store, patch: { cron?: string; enabled?: boolean }): Promise<Settings> {
  const s = await getSettings(store);
  const expr = patch.cron === undefined ? s.schedule_cron : patch.cron.trim();
  const enabled = patch.enabled ?? s.schedule_enabled;
  if (expr !== '' && !describeCron(expr, s.timezone).valid) throw new SettingsError('invalid_cron');
  if (enabled && expr === '') throw new SettingsError('empty_cron');
  const rows: Record<string, string> = { schedule_enabled: enabled ? 'TRUE' : 'FALSE' };
  if (patch.cron !== undefined) rows.schedule_cron = expr;
  await store.upsert('Settings', settingRows(rows), SHEET_KEYS.Settings);
  return { ...s, schedule_cron: expr, schedule_enabled: enabled };
}
