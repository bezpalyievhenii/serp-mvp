import { describe, expect, it } from 'vitest';
import { LockBusyError, acquireLock, releaseLock } from '../src/core/lock';
import { runPipeline } from '../src/core/runPipeline';
import { FakeSerp, freshStore, quietLog } from './helpers';

const now = new Date('2026-11-10T15:00:00Z');

describe('блокировка прогона', () => {
  it('чужая живая блокировка в Settings → вежливый отказ', async () => {
    const store = await freshStore(1);
    await store.upsert('Settings', [
      { key: 'lock_run_id', value: 'other-run' },
      { key: 'lock_expires_at', value: new Date(now.getTime() + 10 * 60_000).toISOString() },
    ], ['key']);
    const err = await runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: () => now }).catch((e) => e);
    expect(err).toBeInstanceOf(LockBusyError);
    expect(err.message).toContain('other-run');
    expect(store.rowsOf('Runs')).toHaveLength(0);
  });

  it('просроченная блокировка перехватывается', async () => {
    const store = await freshStore(1);
    await store.upsert('Settings', [
      { key: 'lock_run_id', value: 'dead-run' },
      { key: 'lock_expires_at', value: new Date(now.getTime() - 60_000).toISOString() },
    ], ['key']);
    const { summary } = await runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: () => now });
    expect(summary.status).toBe('ok');
  });

  it('два прогона одновременно в одном процессе → второй отказывает', async () => {
    const store = await freshStore(2);
    const a = runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: () => now });
    const b = runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: () => now });
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(LockBusyError);
    expect(store.rowsOf('Runs')).toHaveLength(1);
  });

  it('lock ставится с TTL 30 минут и снимается только своим run_id', async () => {
    const store = await freshStore(1);
    await acquireLock(store, 'run-a', now);
    const s = Object.fromEntries(store.rowsOf('Settings').map((r) => [r.key, r.value]));
    expect(s.lock_run_id).toBe('run-a');
    expect(Date.parse(s.lock_expires_at!) - now.getTime()).toBe(30 * 60_000);
    await releaseLock(store, 'run-b'); // чужой id — не снимает
    expect(store.rowsOf('Settings').find((r) => r.key === 'lock_run_id')!.value).toBe('run-a');
    await releaseLock(store, 'run-a');
    expect(store.rowsOf('Settings').find((r) => r.key === 'lock_run_id')!.value).toBe('');
  });
});
