import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrganicRaw, PageSource, ResolvedLinks } from './paged';

/**
 * Офлайн-источник для --dry-run: на любой запрос отдаёт сохранённые страницы
 * tests/fixtures/serp/<provider>-page<N>.json и разбирает их парсером настоящего провайдера.
 */
export class FixtureSource implements PageSource {
  readonly name: string;

  constructor(
    private readonly inner: PageSource,
    private readonly dir: string,
    /** Префикс файлов: по умолчанию имя провайдера (searchapi-page1.json). */
    private readonly prefix: string = inner.name,
  ) {
    this.name = inner.name;
    this.concurrency = inner.concurrency;
  }

  readonly concurrency?: number;

  async fetchPage(_query: string, page: number): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${this.prefix}-page${page}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  parsePage(raw: unknown): OrganicRaw[] {
    return this.inner.parsePage(raw);
  }

  /** Офлайн: токены разворачиваются из файла <provider>-resolved.json, если он есть. */
  async resolve(tokens: string[]): Promise<ResolvedLinks> {
    let map: ResolvedLinks = {};
    try {
      map = JSON.parse(await readFile(join(this.dir, `${this.prefix}-resolved.json`), 'utf8'));
    } catch {
      /* нет файла — токены останутся неразвёрнутыми */
    }
    return Object.fromEntries(tokens.map((t) => [t, map[t] ?? null]));
  }
}
