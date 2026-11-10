// Интерфейсы, через которые ядро общается с внешним миром. Реализации живут в src/adapters.
import type { SheetName } from './schema';
import type { SerpResult } from './types';

export type Cell = string | number | boolean;
/** Строка листа: имя колонки → значение. При чтении все значения приводятся к строкам. */
export type Row = Record<string, Cell>;
export type ReadRow = Record<string, string>;

export interface UpsertResult {
  inserted: number;
  updated: number;
}

export interface SetupReport {
  createdSheets: string[];
  addedColumns: string[];
  addedSettings: string[];
  seededKeywords: number;
  warnings: string[];
}

/**
 * Хранилище. Сейчас Google Sheets (SheetsStore) и память (MemoryStore);
 * позже SQLite/Postgres без правки ядра.
 */
export interface Store {
  /** Читает листы (по одному запросу на пачку листов) и запоминает индекс для upsert. */
  readMany(sheets: SheetName[]): Promise<Record<SheetName, ReadRow[]>>;
  /** Обновляет строки с совпадающим ключом, остальные добавляет. Одна пачка на лист. */
  upsert(sheet: SheetName, rows: Row[], key: readonly string[]): Promise<UpsertResult>;
  /** Полностью перезаписывает лист (используется для History). */
  replaceAll(sheet: SheetName, header: string[], rows: Cell[][]): Promise<void>;
  /** Проверяет листы, заголовки, настройки; дополняет недостающее. */
  ensureSchema(seedKeywords: Row[]): Promise<SetupReport>;
  /** Ссылка на хранилище для людей (например, на таблицу). */
  publicUrl(): string;
}

export type SerpErrorKind = 'auth' | 'quota' | 'rate_limit' | 'bad_request' | 'network' | 'server' | 'no_cache';

export class SerpError extends Error {
  constructor(
    public readonly kind: SerpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SerpError';
  }
}

export interface SerpProvider {
  readonly name: string;
  /** Топ-10 органики. Догружает 2-ю страницу, если на первой меньше 10. */
  search(query: string): Promise<SerpResult>;
  /** Счётчик платных запросов за жизнь объекта (учитывает и упавшие ключи). */
  readonly requestsTotal?: number;
  /** Сколько ключей можно запрашивать одновременно. */
  readonly concurrency?: number;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/* ---------- Разметка (В2) ---------- */

export interface PageLink {
  href: string;
  text: string;
  domain: string;
  internal: boolean;
}

export interface PageInfo {
  finalUrl: string;
  title: string;
  /** Основной текст (Readability). */
  mainText: string;
  /** Весь видимый текст страницы — для проверки цитат-доказательств. */
  fullText: string;
  links: PageLink[];
  emails: string[];
  hasContactForm: boolean;
}

export type PageReadResult = { ok: true; info: PageInfo } | { ok: false; reason: string };

/** Скачивание + извлечение текста и ссылок. Реализация сама ограничивает параллельность. */
export interface PageReader {
  read(url: string): Promise<PageReadResult>;
}

export const PAGE_TYPES = [
  'affiliate_review_or_ranking',
  'media_with_casino_content',
  'casino_operator',
  'encyclopedia',
  'regulator_or_government',
  'forum_or_ugc',
  'app_store_or_platform',
  'payment_provider',
  'other',
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export type ContactType = 'email' | 'form' | 'page' | 'social';
export interface ContactCandidate {
  type: ContactType;
  value: string;
  sourceUrl: string;
}

export interface LabelInput {
  url: string;
  domain: string;
  serpTitle: string;
  serpSnippet: string;
  fetchStatus: string;
  pageTitle: string;
  mainText: string;
  outboundLinks: { text: string; domain: string; href: string }[];
  candidates: ContactCandidate[];
}

export interface LabelRaw {
  page_type: PageType;
  confidence: number;
  reason: string;
  brands: { name: string; evidence: string }[];
  contact_index: number;
}

export interface LabelCall {
  /** null — модель дважды вернула невалидный ответ или запрос упал. */
  result: LabelRaw | null;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Labeler {
  readonly model: string;
  readonly promptVersion: string;
  label(input: LabelInput): Promise<LabelCall>;
}
