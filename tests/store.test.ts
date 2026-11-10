import { describe, expect, it } from 'vitest';
import { isEmptyReport } from '../src/adapters/store/ensureSchema';
import { MemoryStore } from '../src/adapters/store/memoryStore';
import { columnLetter } from '../src/adapters/store/sheetsStore';
import { planUpsert } from '../src/adapters/store/upsertPlan';
import { parseCsv, parseKeywords, parseSettings } from '../src/core/repo';
import { withRetry } from '../src/core/retry';
import { SETTINGS_DEFAULTS, SHEETS } from '../src/core/schema';
import { seed } from './helpers';

describe('planUpsert (общий для SheetsStore и MemoryStore)', () => {
  const header = ['id', 'name', 'note'];
  it('обновляет по ключу, сохраняет чужие колонки, добавляет новые строки', () => {
    const plan = planUpsert(header, [{ id: '1', name: 'a', note: 'manual' }], [{ id: '1', name: 'b' }, { id: '2', name: 'c' }], ['id']);
    expect(plan.updates).toEqual([{ index: 0, values: ['1', 'b', 'manual'] }]);
    expect(plan.appends).toEqual([['2', 'c', '']]);
  });
  it('повторяющийся ключ во входе — одна строка', () => {
    const plan = planUpsert(header, [], [{ id: '1', name: 'a' }, { id: '1', name: 'b' }], ['id']);
    expect(plan.appends).toEqual([['1', 'b', '']]);
  });
  it('составной ключ сравнивается как строки (число 3 = "3")', () => {
    const plan = planUpsert(['d', 'p', 'u'], [{ d: '2026-11-10', p: '3', u: 'x' }], [{ d: '2026-11-10', p: 3, u: 'y' }], ['d', 'p']);
    expect(plan.updates).toHaveLength(1);
    expect(plan.appends).toHaveLength(0);
  });
});

describe('setup на пустом хранилище', () => {
  it('создаёт все листы, заголовки, настройки и стартовые ключи; повтор ничего не меняет', async () => {
    const store = new MemoryStore();
    const r1 = await store.ensureSchema(seed(10));
    expect(r1.createdSheets).toEqual(Object.keys(SHEETS));
    expect(r1.seededKeywords).toBe(10);
    expect(r1.addedSettings).toEqual(Object.keys(SETTINGS_DEFAULTS));
    expect(store.rowsOf('Keywords')).toHaveLength(10);
    const r2 = await store.ensureSchema(seed(10));
    expect(isEmptyReport(r2)).toBe(true);
    expect(store.rowsOf('Keywords')).toHaveLength(10);
  });

  it('недостающая колонка дописывается в конец, данные и порядок не трогаются', async () => {
    const store = new MemoryStore();
    await store.ensureSchema(seed(1));
    const t = store.tables.get('Sites')!;
    t.header = t.header.filter((h) => h !== 'affiliate_targets');
    t.rows = [['https://a.com', 'a.com']];
    const r = await store.ensureSchema(seed(1));
    expect(r.addedColumns).toEqual(['Sites.affiliate_targets']);
    expect(store.tables.get('Sites')!.header.at(-1)).toBe('affiliate_targets');
    expect(store.rowsOf('Sites')[0]).toMatchObject({ url: 'https://a.com', domain: 'a.com', affiliate_targets: '' });
  });

  it('стартовые ключи не заливаются, если лист Keywords уже не пуст', async () => {
    const store = new MemoryStore();
    await store.ensureSchema(seed(2));
    const r = await store.ensureSchema(seed(10));
    expect(r.seededKeywords).toBe(0);
    expect(store.rowsOf('Keywords')).toHaveLength(2);
  });
});

describe('разбор данных из таблицы', () => {
  it('Keywords: TRUE/FALSE/пусто, пустые строки и мусор', () => {
    const warn: string[] = [];
    const kws = parseKeywords(
      [
        { id: 'k01', keyword: 'a', cluster: 'c', active: 'TRUE', added_at: '' },
        { id: 'k02', keyword: 'b', cluster: '', active: 'false', added_at: '' },
        { id: 'k03', keyword: 'c', cluster: '', active: '', added_at: '' },
        { id: '', keyword: '', cluster: '', active: '', added_at: '' },
        { id: 'k05', keyword: 'e', cluster: '', active: 'maybe', added_at: '' },
      ],
      (m) => warn.push(m),
    );
    expect(kws.map((k) => [k.id, k.active])).toEqual([['k01', true], ['k02', false], ['k03', true]]);
    expect(warn).toHaveLength(1);
  });

  it('Settings: числа, значения по умолчанию', () => {
    const s = parseSettings([{ key: 'relabel_days', value: '14' }, { key: 'max_run_cost_usd', value: '' }]);
    expect(s.relabel_days).toBe(14);
    expect(s.max_run_cost_usd).toBe(2);
    expect(s.timezone).toBe('America/Toronto');
  });

  it('CSV стартовых ключей', () => {
    const rows = parseCsv('id,keyword,cluster\nk01,online casino canada,"Денежные, провинция"\n');
    expect(rows).toEqual([{ id: 'k01', keyword: 'online casino canada', cluster: 'Денежные, провинция' }]);
  });
});

describe('утилиты', () => {
  it('columnLetter', () => {
    expect([1, 26, 27, 52, 703].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'AAA']);
  });

  it('withRetry: повторяет только повторяемые ошибки, до лимита', async () => {
    let n = 0;
    const waits: number[] = [];
    const err = await withRetry(
      async () => {
        n++;
        throw Object.assign(new Error('429'), { status: 429 });
      },
      { attempts: 5, baseMs: 100, isRetryable: () => true, sleepFn: async (ms) => void waits.push(ms) },
    ).catch((e) => e);
    expect(err.message).toBe('429');
    expect(n).toBe(5);
    expect(waits).toHaveLength(4);
    waits.forEach((w, i) => expect(w).toBeLessThanOrEqual(100 * 2 ** i));

    n = 0;
    await withRetry(async () => { n++; throw new Error('400'); }, { attempts: 5, baseMs: 1, isRetryable: () => false }).catch(() => {});
    expect(n).toBe(1);
  });
});
