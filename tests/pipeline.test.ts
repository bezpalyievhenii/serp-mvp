import { describe, expect, it } from 'vitest';
import { SerpError } from '../src/core/ports';
import { runPipeline } from '../src/core/runPipeline';
import { FakeSerp, clock, freshStore, quietLog } from './helpers';

const T1 = '2026-11-10T15:00:00Z'; // 10:00 в Торонто
const T1_LATER = '2026-11-10T20:00:00Z';
const T2 = '2026-11-11T15:00:00Z';

describe('runPipeline: идемпотентность (MemoryStore)', () => {
  it('два прогона в один день не создают дублей, новый день добавляет историю', async () => {
    const store = await freshStore();
    const serp = new FakeSerp();
    const c = clock(T1);

    const r1 = await runPipeline({ store, serp, log: quietLog, now: c.now });
    expect(r1.summary.status).toBe('ok');
    expect(r1.summary.run_date).toBe('2026-11-10');
    expect(store.rowsOf('SERP')).toHaveLength(100);
    // 5 общих + 10 ключей × 5 уникальных
    expect(store.rowsOf('Sites')).toHaveLength(55);
    expect(r1.summary.urls_new).toBe(55);
    expect(r1.summary.serp_requests).toBe(10);

    c.set(T1_LATER);
    const r2 = await runPipeline({ store, serp, log: quietLog, now: c.now });
    expect(r2.summary.status).toBe('ok');
    expect(store.rowsOf('SERP')).toHaveLength(100);
    expect(store.rowsOf('Sites')).toHaveLength(55);
    expect(r2.summary.urls_new).toBe(0);

    c.set(T2);
    await runPipeline({ store, serp, log: quietLog, now: c.now });
    expect(store.rowsOf('SERP')).toHaveLength(200);
    expect(store.rowsOf('Sites')).toHaveLength(55);

    const hist = store.rowsOf('History');
    expect(hist).toHaveLength(100); // 10 ключей × 10 URL
    expect(Object.keys(hist[0]!)).toEqual(['keyword', 'normalized_url', 'domain', '2026-11-10', '2026-11-11']);

    expect(store.rowsOf('Runs')).toHaveLength(3);
    // блокировка снята
    const settings = Object.fromEntries(store.rowsOf('Settings').map((r) => [r.key, r.value]));
    expect(settings.lock_run_id).toBe('');
  });

  it('Sites: нормализованный URL, best_position и ключи агрегируются', async () => {
    const store = await freshStore(2);
    await runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: clock(T1).now });
    const shared = store.rowsOf('Sites').find((r) => r.url === 'https://shared-0.com/page')!;
    expect(shared).toMatchObject({ domain: 'shared-0.com', best_position: '1', keywords: 'k01, k02', first_seen: '2026-11-10' });
  });

  it('ручные колонки Sites не стираются при обновлении', async () => {
    const store = await freshStore(1);
    const c = clock(T1);
    await runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: c.now });
    await store.upsert('Sites', [{ url: 'https://shared-0.com/page', page_type: 'affiliate_review_or_ranking', affiliate_targets: 'x.com' }], ['url']);
    c.set(T2);
    await runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: c.now });
    const row = store.rowsOf('Sites').find((r) => r.url === 'https://shared-0.com/page')!;
    expect(row.page_type).toBe('affiliate_review_or_ranking');
    expect(row.affiliate_targets).toBe('x.com');
    expect(row.last_seen).toBe('2026-11-11');
    expect(row.first_seen).toBe('2026-11-10');
  });

  it('выключенный ключ не запрашивается, его история остаётся', async () => {
    const store = await freshStore(3);
    const serp = new FakeSerp();
    const c = clock(T1);
    await runPipeline({ store, serp, log: quietLog, now: c.now });
    await store.upsert('Keywords', [{ id: 'k03', active: 'FALSE' }], ['id']);
    serp.calls = [];
    c.set(T2);
    await runPipeline({ store, serp, log: quietLog, now: c.now });
    expect(serp.calls).toEqual(['keyword 1', 'keyword 2']);
    expect(store.rowsOf('SERP').filter((r) => r.keyword_id === 'k03')).toHaveLength(10);
  });
});

describe('runPipeline: надёжность', () => {
  it('падение одного ключа → partial, остальные записаны', async () => {
    const store = await freshStore(3);
    const serp = new FakeSerp();
    serp.failOn.set('keyword 2', new SerpError('bad_request', 'SearchApi 400: bad'));
    const { summary } = await runPipeline({ store, serp, log: quietLog, now: clock(T1).now });
    expect(summary.status).toBe('partial');
    expect(summary.keywords_ok).toBe(2);
    expect(summary.keywords_failed).toBe(1);
    expect(summary.error).toContain('k02: SearchApi 400');
    expect(store.rowsOf('SERP')).toHaveLength(20);
    expect(store.rowsOf('Runs')[0]!.status).toBe('partial');
  });

  it('неверный ключ SERP → остальные ключи не тратят запросы, статус failed', async () => {
    const store = await freshStore(3);
    const serp = new FakeSerp();
    serp.failOn.set('keyword 1', new SerpError('auth', 'SearchApi 401: Invalid API key. Проверьте SEARCHAPI_KEY'));
    const { summary } = await runPipeline({ store, serp, log: quietLog, now: clock(T1).now });
    expect(serp.calls).toEqual(['keyword 1']);
    expect(summary.status).toBe('failed');
    expect(summary.keywords_failed).toBe(3);
    expect(summary.error).toContain('SEARCHAPI_KEY');
  });

  it('нет активных ключей → failed с понятной причиной', async () => {
    const store = await freshStore(1);
    await store.upsert('Keywords', [{ id: 'k01', active: 'FALSE' }], ['id']);
    const { summary } = await runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: clock(T1).now });
    expect(summary.status).toBe('failed');
    expect(summary.error).toContain('Нет активных ключей');
  });

  it('дата прогона — по America/Toronto', async () => {
    const store = await freshStore(1);
    // 2026-11-11 03:00 UTC = 2026-11-10 22:00 в Торонто
    const { summary } = await runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: clock('2026-11-11T03:00:00Z').now });
    expect(summary.run_date).toBe('2026-11-10');
  });
});

describe('runPipeline: параллельный поиск и хвост позиций', () => {
  it('3 ключа одновременно: строки в порядке ключей, запросы посчитаны', async () => {
    const store = await freshStore(10);
    class SlowSerp extends FakeSerp {
      readonly concurrency = 3;
      active = 0;
      maxActive = 0;
      override async search(q: string) {
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
        this.active--;
        return super.search(q);
      }
    }
    const serp = new SlowSerp();
    const { summary } = await runPipeline({ store, serp, log: quietLog, now: clock(T1).now });
    expect(serp.maxActive).toBe(3);
    expect(summary.serp_requests).toBe(10);
    const ids = store.rowsOf('SERP').map((r) => r.keyword_id);
    expect(ids).toEqual([...ids].sort());
  });

  it('повтор в тот же день с меньшим числом позиций очищает старый хвост', async () => {
    const store = await freshStore(1);
    const c = clock(T1);
    await runPipeline({ store, serp: new FakeSerp(), log: quietLog, now: c.now });
    class Short extends FakeSerp {
      override async search(q: string) {
        const r = await super.search(q);
        return { ...r, items: r.items.slice(0, 8) };
      }
    }
    c.set(T1_LATER);
    await runPipeline({ store, serp: new Short(), log: quietLog, now: c.now });
    const rows = store.rowsOf('SERP');
    expect(rows).toHaveLength(10); // строки не удаляются
    expect(rows.filter((r) => r.normalized_url)).toHaveLength(8);
    expect(rows.find((r) => r.position === '9')!.url).toBe('');
    expect(store.rowsOf('History')).toHaveLength(8);
    // очищенный хвост не превращается в «сайт» с пустым URL
    expect(store.rowsOf('Sites').some((r) => !r.url)).toBe(false);
  });
});
