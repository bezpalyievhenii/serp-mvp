import { z } from 'zod';
import { SerpError } from '../../core/ports';
import { httpJson, type OrganicRaw, type PageSource } from './paged';

// Сверено с https://www.searchapi.io/docs/google 2026-11-10.
// google_domain помечен в доках как deprecated (с 15.04.2025), но google.ca всё ещё в списке допустимых — передаём.
// num больше не поддерживается Google (всегда 10), 2-я страница — page=2.
export const SEARCHAPI_PARAMS = {
  engine: 'google',
  device: 'mobile',
  gl: 'ca',
  hl: 'en',
  google_domain: 'google.ca',
  location: 'Canada',
} as const;

const Organic = z.object({
  link: z.string(),
  link_token: z.string().optional(),
  title: z.string().default(''),
  snippet: z.string().default(''),
});
const ResolveRow = z.object({
  id: z.string().optional(),
  link: z.string().optional(),
  link_token: z.string().optional(),
  error: z.string().optional(),
});
const ResolveBody = z.object({ results: z.array(ResolveRow).default([]), retry_after: z.number().optional() });

/** «Google не вернул результатов» — это пустая выдача (часто на 2-й странице), а не сбой. */
const NO_RESULTS = /didn.t return any results/i;
const Page = z.object({
  organic_results: z.array(z.unknown()).default([]),
  error: z.string().optional(),
});

function classify(status: number, message: string): SerpError {
  const m = `SearchApi ${status}: ${message}`;
  if (status === 401) return new SerpError('auth', `${m}. Проверьте SEARCHAPI_KEY в .env`);
  if (status === 402 || /credit|quota|limit exceeded|upgrade/i.test(message))
    return new SerpError('quota', `${m}. Квота SearchApi исчерпана — переключите SERP_PROVIDER=hasdata`);
  if (status === 429) return new SerpError('rate_limit', `${m}. Лимит частоты запросов SearchApi`);
  if (status === 403) return new SerpError('auth', `${m}. Ключ SearchApi отклонён`);
  if (status >= 500) return new SerpError('server', m);
  return new SerpError('bad_request', m);
}

export class SearchApiSource implements PageSource {
  readonly name = 'searchapi';
  /** Поиск ~2–3 с, разворот ссылок ~20 с: 3 ключа одновременно сокращают прогон в ~3 раза. */
  readonly concurrency = 3;
  private readonly base = 'https://www.searchapi.io/api/v1';

  constructor(
    private readonly apiKey: string,
    private readonly params: Record<string, string> = { ...SEARCHAPI_PARAMS },
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
  }

  async fetchPage(query: string, page: number): Promise<unknown> {
    const qs = new URLSearchParams({ ...this.params, q: query });
    if (page > 1) qs.set('page', String(page));
    const body = await httpJson(`${this.base}/search?${qs}`, { headers: this.headers() }, 'SearchApi', classify);
    const err = (body as { error?: unknown } | null)?.error;
    if (err && NO_RESULTS.test(String(err))) return { organic_results: [], note: String(err) };
    if (err) throw classify(200, String(err));
    return body;
  }

  parsePage(raw: unknown): OrganicRaw[] {
    if (raw === null || raw === undefined) return [];
    const page = Page.parse(raw);
    const out: OrganicRaw[] = [];
    for (const item of page.organic_results) {
      const r = Organic.safeParse(item);
      if (r.success) out.push({ link: r.data.link, title: r.data.title, snippet: r.data.snippet, linkToken: r.data.link_token });
    }
    return out;
  }

  /**
   * Google Resolve API: POST engine=google_resolve, до 25 токенов за раз, кредиты не тратит.
   * Строка без link_token — развёрнута; с error — не развернётся; без error — не готова, повторяем после retry_after.
   */
  async resolve(tokens: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    let pending = [...new Set(tokens)];
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      const next: string[] = [];
      let wait = 0;
      for (let i = 0; i < pending.length; i += 25) {
        const chunk = pending.slice(i, i + 25);
        const raw = await httpJson(
          `${this.base}/search?engine=google_resolve`,
          {
            method: 'POST',
            headers: { ...this.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: 'google_resolve', results: chunk.map((t) => ({ link_token: t, id: t })) }),
          },
          'SearchApi resolve',
          classify,
        );
        const body = ResolveBody.parse(raw);
        body.results.forEach((row, j) => {
          const token = row.id ?? chunk[j]!;
          if (!row.link_token && row.link) out[token] = row.link;
          else if (row.error) out[token] = null;
          else next.push(token);
        });
        wait = Math.max(wait, body.retry_after ?? 0);
      }
      pending = next;
      if (pending.length) await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 0.5), 5) * 1000));
    }
    for (const t of pending) out[t] = null;
    return out;
  }

  /** GET /api/v1/me — остаток кредитов (по докам не тратит поиск). */
  async account() {
    const body = (await httpJson(`${this.base}/me`, { headers: this.headers() }, 'SearchApi', classify)) as {
      account?: { remaining_credits?: number; monthly_allowance?: number; current_month_usage?: number };
    };
    const a = body?.account ?? {};
    return {
      remaining: typeof a.remaining_credits === 'number' ? a.remaining_credits : null,
      details: a.monthly_allowance ? `использовано ${a.current_month_usage ?? 0} из ${a.monthly_allowance} в этом месяце` : 'бесплатные кредиты',
    };
  }
}
