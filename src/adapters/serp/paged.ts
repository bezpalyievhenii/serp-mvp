import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeUrl, unwrapGoogleRedirect } from '../../core/normalize';
import { SerpError, type Logger, type SerpProvider } from '../../core/ports';
import { withRetry } from '../../core/retry';
import { SerpResultSchema, type SerpItem, type SerpResult } from '../../core/types';

export interface OrganicRaw {
  link: string;
  title: string;
  snippet: string;
  /** Токен ссылки-редиректа Google, если провайдер не отдал прямой URL. */
  linkToken?: string;
}

/** token → настоящий URL (null — провайдер не смог развернуть). */
export type ResolvedLinks = Record<string, string | null>;

/** То, что отличает провайдеров: как запросить страницу и как вытащить из неё органику. */
export interface PageSource {
  readonly name: string;
  fetchPage(query: string, page: number): Promise<unknown>;
  parsePage(raw: unknown): OrganicRaw[];
  /** Сколько поисков одновременно позволяет тариф. */
  readonly concurrency?: number;
  /** Разворачивает токены ссылок-редиректов в настоящие URL (без траты поисковых кредитов). */
  resolve?(tokens: string[]): Promise<ResolvedLinks>;
  /** Остаток квоты без траты поиска (для doctor). */
  account?(): Promise<{ remaining: number | null; details: string }>;
}

export interface SerpCacheOptions {
  dir: string;
  runDate: string;
  /**
   * write — всегда запрашивать и сохранять сырые ответы;
   * read — брать последние сохранённые вместо запросов (--from-cache);
   * daily — один снимок выдачи в день: если по ключу уже есть сегодняшний снимок, взять его, иначе запросить и сохранить.
   */
  mode: 'write' | 'read' | 'daily';
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const isGoogleUrl = (u: string) => {
  try {
    return /(^|\.)google\.[a-z.]+$/.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

const isRetryableSerp = (e: unknown) => e instanceof SerpError && (e.kind === 'network' || e.kind === 'server');

/**
 * Общая логика топ-10: страница 1 → если органики меньше 10, страница 2.
 * Ссылки-редиректы Google разворачиваются, дубли (после нормализации) выкидываются,
 * позиции перенумеровываются 1..10 по порядку выдачи.
 */
export class PagedSerpProvider implements SerpProvider {
  readonly name: string;
  /** Сколько платных запросов ушло за жизнь объекта — в том числе по ключам, которые потом упали. */
  requestsTotal = 0;
  readonly concurrency: number;

  constructor(
    private readonly src: PageSource,
    private readonly log: Logger,
    private readonly cache?: SerpCacheOptions,
  ) {
    this.name = src.name;
    this.concurrency = src.concurrency ?? 1;
  }

  async search(query: string): Promise<SerpResult> {
    const pages: unknown[] = [];
    let fromCache = this.cache?.mode === 'read';
    if (this.cache?.mode === 'daily' && (await this.hasToday(query))) {
      fromCache = true;
      this.log.info(`[${query}] выдача из сегодняшнего снимка (cache/serp/${this.cache.runDate}); свежая — с --refresh`);
    }
    const resolved: ResolvedLinks = fromCache ? await this.readCachedResolved(query) : {};
    let requests = 0;
    const getPage = async (page: number): Promise<unknown> => {
      if (fromCache) return this.readCached(query, page);
      // Ретрай только на сеть и 5xx и только один раз: квоту бережём.
      const raw = await withRetry(() => this.src.fetchPage(query, page), { attempts: 2, baseMs: 1500, isRetryable: isRetryableSerp });
      requests++;
      this.requestsTotal++;
      return raw;
    };

    const items: SerpItem[] = [];
    const seen = new Set<string>();
    for (const page of [1, 2]) {
      const raw = await getPage(page);
      pages.push(raw);
      const organic = this.src.parsePage(raw);

      // Ниже 3-й позиции SearchApi отдаёт google.com/goto + link_token — разворачиваем пачкой (бесплатно).
      const tokens = organic
        .filter((o) => o.linkToken && isGoogleUrl(o.link) && !(o.linkToken in resolved))
        .map((o) => o.linkToken!);
      if (tokens.length && this.src.resolve) {
        try {
          Object.assign(resolved, await this.src.resolve(tokens));
        } catch (e) {
          this.log.warn(`[${query}] не удалось развернуть ссылки Google: ${(e as Error).message}`);
        }
      }

      for (const o of organic) {
        if (items.length >= 10) break;
        const link = (o.linkToken && resolved[o.linkToken]) || unwrapGoogleRedirect(o.link);
        let key: string;
        try {
          key = normalizeUrl(link);
        } catch {
          this.log.warn(`[${query}] пропущена ссылка без http(s): ${link.slice(0, 120)}`);
          continue;
        }
        if (isGoogleUrl(key)) {
          this.log.warn(`[${query}] пропущена неразвёрнутая ссылка Google («${o.title.slice(0, 60)}»)`);
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ position: items.length + 1, url: link, title: o.title, snippet: o.snippet });
      }
      if (items.length >= 10) break;
      if (page === 1) this.log.info(`[${query}] на 1-й странице ${items.length} органических результатов — догружаю 2-ю`);
    }
    if (items.length < 10) this.log.warn(`[${query}] после 2 страниц только ${items.length} результатов`);

    if (!fromCache && (this.cache?.mode === 'write' || this.cache?.mode === 'daily')) await this.writeCached(query, pages, resolved);
    return SerpResultSchema.parse({ query, provider: this.name, items, requests, pagesFetched: pages.length });
  }

  account() {
    return this.src.account?.();
  }

  private cacheFile(date: string, query: string) {
    return join(this.cache!.dir, date, this.name, `${slug(query)}.json`);
  }

  private async writeCached(query: string, pages: unknown[], resolved: ResolvedLinks) {
    const file = this.cacheFile(this.cache!.runDate, query);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ query, provider: this.name, saved_at: new Date().toISOString(), pages, resolved }, null, 1));
  }

  private async hasToday(query: string): Promise<boolean> {
    try {
      await readFile(this.cacheFile(this.cache!.runDate, query));
      return true;
    } catch {
      return false;
    }
  }

  private cachedPages = new Map<string, unknown[]>();
  private cachedResolved = new Map<string, ResolvedLinks>();

  private async readCachedResolved(query: string): Promise<ResolvedLinks> {
    await this.readCached(query, 1);
    return { ...(this.cachedResolved.get(query) ?? {}) };
  }

  private async readCached(query: string, page: number): Promise<unknown> {
    if (!this.cachedPages.has(query)) {
      let dates: string[] = [];
      try {
        dates = (await readdir(this.cache!.dir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
      } catch {
        /* нет каталога кеша */
      }
      let found: unknown[] | null = null;
      for (const d of dates) {
        try {
          const file = JSON.parse(await readFile(this.cacheFile(d, query), 'utf8'));
          found = file.pages;
          this.cachedResolved.set(query, file.resolved ?? {});
          break;
        } catch {
          /* в этой дате нет — ищем раньше */
        }
      }
      if (!found) throw new SerpError('no_cache', `Нет сохранённой выдачи для «${query}» (${this.name}). Нужен обычный прогон без --from-cache`);
      this.cachedPages.set(query, found);
    }
    const pages = this.cachedPages.get(query)!;
    // Страницы 2 в кеше может не быть (на 1-й хватило 10) — тогда пустая органика.
    return pages[page - 1] ?? null;
  }
}

/** Общий HTTP-вызов с понятными ошибками. Ключ никогда не попадает в текст ошибки. */
export async function httpJson(
  url: string,
  init: RequestInit,
  provider: string,
  classify: (status: number, message: string) => SerpError,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    throw new SerpError('network', `${provider}: сеть недоступна или таймаут (${(e as Error).message})`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  if (!res.ok) {
    const b = body as { error?: unknown; message?: unknown } | null;
    const msg = String(b?.error ?? b?.message ?? text.slice(0, 200)).slice(0, 300);
    throw classify(res.status, msg);
  }
  return body;
}
