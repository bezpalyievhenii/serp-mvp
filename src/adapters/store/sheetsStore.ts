import { readFileSync } from 'node:fs';
import { auth, sheets, type sheets_v4 } from '@googleapis/sheets';
import type { Cell, Logger, ReadRow, Row, SetupReport, Store, UpsertResult } from '../../core/ports';
import { withRetry } from '../../core/retry';
import { SHEET_KEYS, SHEET_NAMES, type SheetName } from '../../core/schema';
import { planSchema } from './ensureSchema';
import { cellToString, planUpsert } from './upsertPlan';

interface CachedTable {
  header: string[];
  rows: ReadRow[];
}

/** HTTP-статус из ошибки googleapis/gaxios. */
export function googleStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e?.response?.status, e?.status, e?.code]) if (typeof v === 'number') return v;
  return undefined;
}

const isRetryable = (err: unknown) => {
  const s = googleStatus(err);
  if (s === undefined) return true; // сеть
  return s === 429 || s >= 500;
};

const q = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;

export function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * Боевое хранилище — Google Sheets через сервисный аккаунт.
 * Правила квот: одно чтение на пачку листов, одна пачка обновлений и одна пачка добавлений на лист.
 */
export class SheetsStore implements Store {
  private readonly api: sheets_v4.Sheets;
  private readonly cache = new Map<string, CachedTable>();

  constructor(
    private readonly spreadsheetId: string,
    keyFile: string,
    private readonly log: Logger,
  ) {
    // JWT-клиент сервисного аккаунта напрямую: опции keyFile/credentials в google-auth-library устарели.
    const sa = JSON.parse(readFileSync(keyFile, 'utf8')) as { client_email: string; private_key: string };
    const jwt = new auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    this.api = sheets({ version: 'v4', auth: jwt });
  }

  private call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      attempts: 5,
      baseMs: 1000,
      isRetryable,
      onRetry: (err, attempt, delay) =>
        this.log.warn(`Sheets ${what}: ${googleStatus(err) ?? 'сеть'}, повтор ${attempt}/4 через ${delay} мс`),
    });
  }

  async meta() {
    const res = await this.call('get', () =>
      this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'properties(title,timeZone),sheets.properties(sheetId,title,gridProperties)',
      }),
    );
    return res.data;
  }

  async readMany(names: SheetName[]): Promise<Record<SheetName, ReadRow[]>> {
    const res = await this.call('batchGet', () =>
      this.api.spreadsheets.values.batchGet({
        spreadsheetId: this.spreadsheetId,
        ranges: names.map(q),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      }),
    );
    const out = {} as Record<SheetName, ReadRow[]>;
    names.forEach((name, i) => {
      const values = (res.data.valueRanges?.[i]?.values ?? []) as unknown[][];
      const header = (values[0] ?? []).map(cellToString);
      const rows = values.slice(1).map((r) => Object.fromEntries(header.map((h, j) => [h, cellToString(r[j])])));
      this.cache.set(name, { header, rows });
      out[name] = rows;
    });
    return out;
  }

  async upsert(sheet: SheetName, rows: Row[], key: readonly string[]): Promise<UpsertResult> {
    if (!rows.length) return { inserted: 0, updated: 0 };
    if (!this.cache.has(sheet)) await this.readMany([sheet]);
    const t = this.cache.get(sheet)!;
    if (!t.header.length) throw new Error(`Лист ${sheet} без заголовков. Запустите npm run setup`);
    const plan = planUpsert(t.header, t.rows, rows, key);
    const lastCol = columnLetter(t.header.length);

    if (plan.updates.length) {
      await this.call(`batchUpdate ${sheet}`, () =>
        this.api.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: plan.updates.map((u) => ({
              range: `${q(sheet)}!A${u.index + 2}:${lastCol}${u.index + 2}`,
              values: [u.values],
            })),
          },
        }),
      );
    }
    if (plan.appends.length) {
      await this.call(`append ${sheet}`, () =>
        this.api.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: `${q(sheet)}!A1:${lastCol}1`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: plan.appends },
        }),
      );
    }
    // Держим кеш в актуальном состоянии для следующих upsert в этом процессе.
    const toRead = (v: Cell[]) => Object.fromEntries(t.header.map((h, j) => [h, cellToString(v[j])]));
    for (const u of plan.updates) t.rows[u.index] = toRead(u.values);
    t.rows.push(...plan.appends.map(toRead));
    return { inserted: plan.appends.length, updated: plan.updates.length };
  }

  async replaceAll(sheet: SheetName, header: string[], rows: Cell[][]): Promise<void> {
    const meta = await this.meta();
    const props = meta.sheets?.find((s) => s.properties?.title === sheet)?.properties;
    if (!props) throw new Error(`Нет листа ${sheet}. Запустите npm run setup`);
    const needCols = header.length;
    const needRows = rows.length + 1;
    const grid = props.gridProperties ?? {};
    const requests: sheets_v4.Schema$Request[] = [];
    if ((grid.columnCount ?? 0) < needCols)
      requests.push({ appendDimension: { sheetId: props.sheetId, dimension: 'COLUMNS', length: needCols - (grid.columnCount ?? 0) } });
    if ((grid.rowCount ?? 0) < needRows)
      requests.push({ appendDimension: { sheetId: props.sheetId, dimension: 'ROWS', length: needRows - (grid.rowCount ?? 0) } });
    if (requests.length)
      await this.call('resize', () =>
        this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } }),
      );

    await this.call(`clear ${sheet}`, () =>
      this.api.spreadsheets.values.clear({ spreadsheetId: this.spreadsheetId, range: q(sheet) }),
    );
    await this.call(`update ${sheet}`, () =>
      this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${q(sheet)}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [header, ...rows] },
      }),
    );
    this.cache.set(sheet, {
      header,
      rows: rows.map((r) => Object.fromEntries(header.map((h, j) => [h, cellToString(r[j])]))),
    });
  }

  async ensureSchema(seedKeywords: Row[]): Promise<SetupReport> {
    const meta = await this.meta();
    const existing = new Set((meta.sheets ?? []).map((s) => s.properties?.title ?? ''));
    const present = SHEET_NAMES.filter((n) => existing.has(n));
    const data = present.length ? await this.readMany(present) : ({} as Record<SheetName, ReadRow[]>);
    const headers: Partial<Record<SheetName, string[]>> = {};
    for (const n of present) headers[n] = this.cache.get(n)!.header;

    const ch = planSchema(
      {
        sheets: existing,
        headers,
        settingsKeys: new Set((data.Settings ?? []).map((r) => r.key ?? '')),
        keywordsCount: (data.Keywords ?? []).filter((r) => r.id).length,
      },
      seedKeywords,
    );

    if (ch.newSheets.length) {
      await this.call('addSheet', () =>
        this.api.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: { requests: ch.newSheets.map((title) => ({ addSheet: { properties: { title } } })) },
        }),
      );
      for (const n of ch.newSheets) this.cache.set(n, { header: [], rows: [] });
    }
    const writes = Object.entries(ch.headerWrites) as [SheetName, string[]][];
    if (writes.length) {
      await this.call('headers', () =>
        this.api.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: writes.map(([n, h]) => ({ range: `${q(n)}!A1:${columnLetter(h.length)}1`, values: [h] })),
          },
        }),
      );
      for (const [n, h] of writes) {
        const t = this.cache.get(n)!;
        t.header = h;
        t.rows = t.rows.map((r) => Object.fromEntries(h.map((col) => [col, r[col] ?? ''])));
      }
    }
    if (ch.settingsRows.length) await this.upsert('Settings', ch.settingsRows, SHEET_KEYS.Settings);
    if (ch.keywordRows.length) await this.upsert('Keywords', ch.keywordRows, SHEET_KEYS.Keywords);

    const tz = meta.properties?.timeZone;
    if (tz && tz !== 'America/Toronto')
      ch.report.warnings.push(`Часовой пояс таблицы ${tz}. Даты прогона всё равно считаются по Settings.timezone`);
    return ch.report;
  }

  /** Заголовок листа из последнего чтения (пусто, если лист не читался или пуст). */
  headerOf(sheet: SheetName): string[] {
    return this.cache.get(sheet)?.header ?? [];
  }

  /** Проверка права на запись без изменения данных: перезаписывает ячейку A1 листа Settings тем же значением. */
  async checkWrite(): Promise<void> {
    const range = `${q('Settings')}!A1`;
    const cur = await this.call('get A1', () => this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range }));
    const value = cur.data.values?.[0]?.[0] ?? 'key';
    await this.call('write A1', () =>
      this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: [[value]] },
      }),
    );
  }

  publicUrl(): string {
    return `https://docs.google.com/spreadsheets/d/${this.spreadsheetId}/edit`;
  }
}
