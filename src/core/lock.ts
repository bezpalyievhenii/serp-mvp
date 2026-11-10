import type { Store } from './ports';
import { settingRows, settingsMap } from './repo';

export const LOCK_TTL_MS = 30 * 60 * 1000;

export class LockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockBusyError';
  }
}

// Блокировка внутри процесса: веб-кнопка и планировщик живут в одном процессе.
let inProcess: string | null = null;

/**
 * Двойная блокировка: в процессе и в листе Settings (lock_run_id + lock_expires_at, TTL 30 мин).
 * Запись в Sheets не атомарна, поэтому после записи перечитываем и сверяем свой run_id.
 */
export async function acquireLock(store: Store, runId: string, now: Date, ttlMs = LOCK_TTL_MS): Promise<void> {
  if (inProcess) throw new LockBusyError(`Уже идёт прогон ${inProcess}. Дождитесь его окончания.`);
  inProcess = runId;
  try {
    const cur = settingsMap((await store.readMany(['Settings'])).Settings);
    const expires = Date.parse(cur.lock_expires_at ?? '');
    if (cur.lock_run_id && Number.isFinite(expires) && expires > now.getTime()) {
      throw new LockBusyError(
        `Уже идёт прогон ${cur.lock_run_id} (блокировка до ${new Date(expires).toISOString()}). Дождитесь его окончания.`,
      );
    }
    await store.upsert(
      'Settings',
      settingRows({ lock_run_id: runId, lock_expires_at: new Date(now.getTime() + ttlMs).toISOString() }),
      ['key'],
    );
    const check = settingsMap((await store.readMany(['Settings'])).Settings);
    if (check.lock_run_id !== runId) throw new LockBusyError(`Блокировку перехватил прогон ${check.lock_run_id}.`);
  } catch (e) {
    inProcess = null;
    throw e;
  }
}

export async function releaseLock(store: Store, runId: string): Promise<void> {
  try {
    const cur = settingsMap((await store.readMany(['Settings'])).Settings);
    if (cur.lock_run_id === runId) await store.upsert('Settings', settingRows({ lock_run_id: '', lock_expires_at: '' }), ['key']);
  } finally {
    if (inProcess === runId) inProcess = null;
  }
}

export const currentInProcessRun = () => inProcess;
