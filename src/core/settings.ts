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

export async function setSchedule(store: Store, cron: string): Promise<Settings> {
  const expr = cron.trim();
  const s = await getSettings(store);
  if (expr !== '' && !describeCron(expr, s.timezone).valid) throw new SettingsError('invalid_cron');
  await store.upsert('Settings', settingRows({ schedule_cron: expr }), SHEET_KEYS.Settings);
  return { ...s, schedule_cron: expr };
}
