import type { PageReadResult, PageReader } from '../../core/ports';
import { extractPage } from './extract';

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

export interface ReaderOptions {
  timeoutMs: number;
  maxBytes: number;
  concurrency: number;
}

const DEFAULTS: ReaderOptions = { timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024, concurrency: 5 };

/** Простой семафор: не больше N одновременных скачиваний на весь прогон. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Скачивание страниц: таймаут 15 с, мобильный UA, лимит 3 МБ, не больше 5 параллельно. */
export class HttpPageReader implements PageReader {
  private readonly opts: ReaderOptions;
  private readonly limiter: Limiter;

  constructor(opts: Partial<ReaderOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.limiter = new Limiter(this.opts.concurrency);
  }

  read(url: string): Promise<PageReadResult> {
    return this.limiter.run(() => this.readNow(url));
  }

  private async readNow(url: string): Promise<PageReadResult> {
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        headers: {
          'User-Agent': MOBILE_UA,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-CA,en;q=0.9',
        },
      });
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { ok: false, reason: timeout ? 'timeout 15s' : `network: ${err.message}`.slice(0, 120) };
    }

    const type = res.headers.get('content-type') ?? '';
    const body = await this.readLimited(res).catch(() => '');
    const cloudflare =
      res.headers.get('cf-mitigated') === 'challenge' ||
      /Just a moment\.\.\.|Attention Required! \| Cloudflare|cf-browser-verification|challenge-platform/i.test(body.slice(0, 30_000));
    if (cloudflare && (!res.ok || body.length < 30_000)) return { ok: false, reason: `Cloudflare challenge (HTTP ${res.status})` };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    if (type && !/html|xml/i.test(type)) return { ok: false, reason: `not html (${type.split(';')[0]})` };
    if (body.length < 200) return { ok: false, reason: 'empty page' };
    try {
      return { ok: true, info: extractPage(body, res.url || url) };
    } catch (e) {
      return { ok: false, reason: `parse error: ${(e as Error).message}`.slice(0, 120) };
    }
  }

  /** Читает тело не больше maxBytes; хвост отбрасывается — для разметки хватает начала страницы. */
  private async readLimited(res: Response): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= this.opts.maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    const buf = new Uint8Array(Math.min(size, this.opts.maxBytes));
    let off = 0;
    for (const c of chunks) {
      const n = Math.min(c.byteLength, buf.byteLength - off);
      buf.set(c.subarray(0, n), off);
      off += n;
      if (off >= buf.byteLength) break;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}
