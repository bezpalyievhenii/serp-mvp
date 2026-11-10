import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureSource } from '../src/adapters/serp/fixture';
import { HasDataSource } from '../src/adapters/serp/hasdata';
import { PagedSerpProvider } from '../src/adapters/serp/paged';
import { SEARCHAPI_PARAMS, SearchApiSource } from '../src/adapters/serp/searchapi';
import { SerpError } from '../src/core/ports';
import { quietLog } from './helpers';

const dir = join(import.meta.dirname, 'fixtures', 'serp');

describe('SearchApi: разбор выдачи по фикстуре', () => {
  it('берёт 10 органических, догружает 2-ю страницу, чистит дубли и редиректы', async () => {
    const p = new PagedSerpProvider(new FixtureSource(new SearchApiSource('test'), dir), quietLog);
    const r = await p.search('online casino canada');
    expect(r.items).toHaveLength(10);
    expect(r.items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.requests).toBe(2);
    expect(r.pagesFetched).toBe(2);
    const urls = r.items.map((i) => i.url);
    // редирект Google развёрнут
    expect(urls[3]).toBe('https://www.igamingontario.ca/en/player/regulated-igaming-market#frag');
    // дубль casino.org (после нормализации) и дубль covers.com со 2-й страницы выкинуты
    expect(urls.filter((u) => u.toLowerCase().includes('casino.org'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('covers.com'))).toHaveLength(1);
    // элемент без link пропущен, 11-й результат не взят
    expect(urls.some((u) => u.includes('oddschecker'))).toBe(false);
    expect(urls.at(-1)).toBe('https://www.agco.ca/en/lottery-and-gaming');
  });

  it('параметры запроса совпадают с задачей', () => {
    expect(SEARCHAPI_PARAMS).toMatchObject({ engine: 'google', device: 'mobile', gl: 'ca', hl: 'en', google_domain: 'google.ca', location: 'Canada' });
  });
});

describe('SearchApi: реальный ответ (2026-11-10)', () => {
  it('позиции 3+ приходят как google.com/goto + link_token и разворачиваются через Resolve API', async () => {
    const p = new PagedSerpProvider(new FixtureSource(new SearchApiSource('test'), dir, 'searchapi-real'), quietLog);
    const r = await p.search('online casino canada');
    expect(r.items).toHaveLength(10);
    expect(r.requests).toBe(1); // 10 органических на 1-й странице — 2-ю не трогаем
    expect(r.items.every((i) => !/google\.com\/goto/.test(i.url))).toBe(true);
    expect(r.items[0]!.url).toBe('https://www.betiton.com/en-ca/casino/');
    expect(r.items[2]!.url).toBe('https://www.gambling.com/ca');
  });

  it('без Resolve API неразвёрнутые ссылки пропускаются, а не пишутся как google.com', async () => {
    const src = new SearchApiSource('test');
    const noResolve = { name: src.name, fetchPage: (q: string, n: number) => new FixtureSource(src, dir, 'searchapi-real').fetchPage(q, n), parsePage: (raw: unknown) => src.parsePage(raw) };
    const r = await new PagedSerpProvider(noResolve, quietLog).search('q');
    expect(r.items.every((i) => !i.url.includes('google.com'))).toBe(true);
  });

  it('«Google didn\'t return any results» — пустая страница, а не ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: "Google didn't return any results." }), { status: 200 })));
    const page = await new SearchApiSource('k').fetchPage('q', 2);
    expect(new SearchApiSource('k').parsePage(page)).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe('HasData: разбор выдачи по фикстуре', () => {
  it('10 результатов с 1-й страницы, 1 запрос', async () => {
    const p = new PagedSerpProvider(new FixtureSource(new HasDataSource('test'), dir), quietLog);
    const r = await p.search('x');
    expect(r.items).toHaveLength(10);
    expect(r.requests).toBe(1);
  });
});

describe('ошибки провайдера', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('401 → auth с подсказкой про ключ, ключ не попадает в текст', async () => {
    respond(401, { error: 'Invalid API key' });
    const err = (await new SearchApiSource('secret-key-123').fetchPage('q', 1).catch((e: SerpError) => e)) as SerpError;
    expect(err).toBeInstanceOf(SerpError);
    expect(err.kind).toBe('auth');
    expect(err.message).toContain('SEARCHAPI_KEY');
    expect(err.message).not.toContain('secret-key-123');
  });

  it('квота SearchApi → quota', async () => {
    respond(429, { error: 'You have run out of credits. Please upgrade your plan.' });
    const err = (await new SearchApiSource('k').fetchPage('q', 1).catch((e: SerpError) => e)) as SerpError;
    expect(err.kind).toBe('quota');
  });

  it('HasData 403 → quota', async () => {
    respond(403, { message: 'You have used up all your API credits.' });
    const err = (await new HasDataSource('k').fetchPage('q', 1).catch((e: SerpError) => e)) as SerpError;
    expect(err.kind).toBe('quota');
  });

  it('500 повторяется один раз, потом ошибка server', async () => {
    const f = vi.fn(async () => new Response('oops', { status: 500 }));
    vi.stubGlobal('fetch', f);
    const p = new PagedSerpProvider(new SearchApiSource('k'), quietLog);
    const err = (await p.search('q').catch((e: SerpError) => e)) as SerpError;
    expect(err.kind).toBe('server');
    expect(f).toHaveBeenCalledTimes(2);
  }, 10_000);
});

describe('один снимок выдачи в день (режим daily)', () => {
  it('первый поиск за день идёт в сеть и сохраняется, повтор в тот же день — из снимка, новый день — снова в сеть', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const cacheDir = await mkdtemp(join(tmpdir(), 'serp-cache-'));
    const src = new FixtureSource(new SearchApiSource('test'), dir, 'searchapi-real');
    let calls = 0;
    const counting = { ...src, name: src.name, fetchPage: (q: string, n: number) => (calls++, src.fetchPage(q, n)), parsePage: (r: unknown) => src.parsePage(r), resolve: (t: string[]) => src.resolve(t) };

    const day1 = new PagedSerpProvider(counting, quietLog, { dir: cacheDir, runDate: '2026-11-10', mode: 'daily' });
    const a = await day1.search('online casino canada');
    expect(a.requests).toBe(1);

    const again = new PagedSerpProvider(counting, quietLog, { dir: cacheDir, runDate: '2026-11-10', mode: 'daily' });
    const b = await again.search('online casino canada');
    expect(b.requests).toBe(0);
    expect(b.items).toEqual(a.items);
    expect(calls).toBe(1);

    const day2 = new PagedSerpProvider(counting, quietLog, { dir: cacheDir, runDate: '2026-11-11', mode: 'daily' });
    expect((await day2.search('online casino canada')).requests).toBe(1);
    expect(calls).toBe(2);
  });
});
