import { z } from 'zod';
import { SerpError } from '../../core/ports';
import { httpJson, type OrganicRaw, type PageSource } from './paged';

// Сверено с https://docs.hasdata.com/apis/google-serp-api/api-params 2026-11-10.
// 2-я страница — start=10. Ключ — заголовок x-api-key. 403 = кончились кредиты.
export const HASDATA_PARAMS = {
  deviceType: 'mobile',
  gl: 'ca',
  hl: 'en',
  domain: 'google.ca',
  location: 'Canada',
} as const;

const Organic = z.object({
  link: z.string(),
  title: z.string().default(''),
  snippet: z.string().default(''),
});
const Page = z.object({ organicResults: z.array(z.unknown()).default([]) });

function classify(status: number, message: string): SerpError {
  const m = `HasData ${status}: ${message}`;
  if (status === 401) return new SerpError('auth', `${m}. Проверьте HASDATA_KEY в .env`);
  if (status === 403) return new SerpError('quota', `${m}. Кредиты HasData закончились`);
  if (status === 429) return new SerpError('rate_limit', `${m}. Превышен лимит параллельных запросов HasData`);
  if (status >= 500) return new SerpError('server', m);
  return new SerpError('bad_request', m);
}

export class HasDataSource implements PageSource {
  readonly name = 'hasdata';
  /** Бесплатный тариф HasData — 1 одновременный запрос. */
  readonly concurrency = 1;
  private readonly base = 'https://api.hasdata.com';

  constructor(
    private readonly apiKey: string,
    private readonly params: Record<string, string> = { ...HASDATA_PARAMS },
  ) {}

  private headers() {
    return { 'x-api-key': this.apiKey, Accept: 'application/json' };
  }

  async fetchPage(query: string, page: number): Promise<unknown> {
    const qs = new URLSearchParams({ ...this.params, q: query });
    if (page > 1) qs.set('start', String((page - 1) * 10));
    return httpJson(`${this.base}/scrape/google/serp?${qs}`, { headers: this.headers() }, 'HasData', classify);
  }

  parsePage(raw: unknown): OrganicRaw[] {
    if (raw === null || raw === undefined) return [];
    const out: OrganicRaw[] = [];
    for (const item of Page.parse(raw).organicResults) {
      const r = Organic.safeParse(item);
      if (r.success) out.push(r.data);
    }
    return out;
  }

  async account() {
    const body = (await httpJson(`${this.base}/user/me/usage`, { headers: this.headers() }, 'HasData', classify)) as {
      data?: { availableCredits?: number; totalCredits?: number };
    };
    const d = body?.data ?? {};
    return {
      remaining: typeof d.availableCredits === 'number' ? Math.floor(d.availableCredits / 10) : null,
      details: `кредитов ${d.availableCredits ?? '?'} из ${d.totalCredits ?? '?'} (10 кредитов = 1 запрос)`,
    };
  }
}
