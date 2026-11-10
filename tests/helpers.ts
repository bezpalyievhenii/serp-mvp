import { MemoryStore } from '../src/adapters/store/memoryStore';
import { SerpError, type Logger, type Row, type SerpProvider } from '../src/core/ports';
import type { SerpResult } from '../src/core/types';

export const quietLog: Logger & { lines: string[] } = {
  lines: [],
  info(m) {
    this.lines.push(m);
  },
  warn(m) {
    this.lines.push('WARN ' + m);
  },
  error(m) {
    this.lines.push('ERROR ' + m);
  },
};

export const seed = (n = 10): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `k${String(i + 1).padStart(2, '0')}`,
    keyword: `keyword ${i + 1}`,
    cluster: 'test',
    active: true,
    added_at: '2026-11-10',
  }));

export async function freshStore(n = 10) {
  const s = new MemoryStore();
  await s.ensureSchema(seed(n));
  return s;
}

/** Детерминированный провайдер: у каждого ключа 10 URL, часть общих между ключами. */
export class FakeSerp implements SerpProvider {
  readonly name = 'fake';
  calls: string[] = [];
  failOn = new Map<string, SerpError | Error>();

  async search(query: string): Promise<SerpResult> {
    this.calls.push(query);
    const err = this.failOn.get(query);
    if (err) throw err;
    const n = Number(query.split(' ').at(-1));
    return {
      query,
      provider: this.name,
      requests: 1,
      pagesFetched: 1,
      items: Array.from({ length: 10 }, (_, i) => ({
        position: i + 1,
        // общие сайты shared-0..4 встречаются во всех ключах, остальные уникальны
        url: i < 5 ? `https://www.shared-${i}.com/page/?utm_source=x` : `https://site-${n}-${i}.ca/`,
        title: `t${i}`,
        snippet: `s${i}`,
      })),
    };
  }
}

/** Часы, которые можно переставить на следующий день. */
export function clock(iso: string) {
  let t = new Date(iso);
  return {
    now: () => t,
    set: (s: string) => (t = new Date(s)),
  };
}
