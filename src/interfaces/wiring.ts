// Точка сборки: какие адаптеры подставить в ядро. Интерфейсы (cli, http) берут зависимости отсюда.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR, DEFAULT_MODEL, FIXTURES_DIR, PROMPT_FILE, SEED_FILE, type Env } from '../config';
import { HttpPageReader } from '../adapters/fetcher/httpPageReader';
import { AnthropicLabeler } from '../adapters/llm/anthropicLabeler';
import type { Labeler, Logger, PageReader, Row, Store } from '../core/ports';
import { parseCsv } from '../core/repo';
import { FixtureSource } from '../adapters/serp/fixture';
import { HasDataSource } from '../adapters/serp/hasdata';
import { PagedSerpProvider, type PageSource } from '../adapters/serp/paged';
import { SearchApiSource } from '../adapters/serp/searchapi';
import { MemoryStore } from '../adapters/store/memoryStore';
import { SheetsStore } from '../adapters/store/sheetsStore';
import { dateInTz } from '../core/time';

export const consoleLogger: Logger = {
  info: (m) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${m}`),
  warn: (m) => console.warn(`${new Date().toTimeString().slice(0, 8)}  ⚠ ${m}`),
  error: (m) => console.error(`${new Date().toTimeString().slice(0, 8)}  ✗ ${m}`),
};

export function buildPageSource(env: Env): PageSource {
  return env.SERP_PROVIDER === 'hasdata' ? new HasDataSource(env.HASDATA_KEY) : new SearchApiSource(env.SEARCHAPI_KEY);
}

/** live — один снимок в день (повтор в тот же день берёт сегодняшний снимок); refresh — всегда свежая выдача. */
export type SerpMode = 'live' | 'refresh' | 'cache' | 'fixture';

export function buildSerp(env: Env, log: Logger, mode: SerpMode, timezone = 'America/Toronto') {
  const src = buildPageSource(env);
  if (mode === 'fixture') return new PagedSerpProvider(new FixtureSource(src, join(FIXTURES_DIR, 'serp')), log);
  return new PagedSerpProvider(src, log, {
    dir: CACHE_DIR,
    runDate: dateInTz(new Date(), timezone),
    mode: mode === 'cache' ? 'read' : mode === 'refresh' ? 'write' : 'daily',
  });
}

export function buildSheetsStore(env: Env, log: Logger): SheetsStore {
  return new SheetsStore(env.GOOGLE_SHEET_ID, env.GOOGLE_APPLICATION_CREDENTIALS, log);
}

export async function seedKeywords(today: string): Promise<Row[]> {
  const rows = parseCsv(await readFile(SEED_FILE, 'utf8'));
  return rows.map((r) => ({ id: r.id!, keyword: r.keyword!, cluster: r.cluster ?? '', active: (r.active ?? 'TRUE').toUpperCase() !== 'FALSE', added_at: today }));
}

/** MemoryStore, заполненный как свежая таблица: для --dry-run. */
export async function buildMemoryStore(): Promise<Store> {
  const store = new MemoryStore();
  await store.ensureSchema(await seedKeywords(dateInTz(new Date(), 'America/Toronto')));
  return store;
}

/** Разметка (В2): скачивание страниц + классификатор Anthropic с промптом из prompts/classify.md. */
export function buildLabeling(env: Env): { reader: PageReader; labeler: Labeler } {
  return {
    reader: new HttpPageReader(),
    labeler: new AnthropicLabeler(env.ANTHROPIC_API_KEY, env.LLM_MODEL || DEFAULT_MODEL, PROMPT_FILE),
  };
}
