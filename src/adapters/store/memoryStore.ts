import type { Cell, ReadRow, Row, SetupReport, Store, UpsertResult } from '../../core/ports';
import { SHEET_KEYS, type SheetName } from '../../core/schema';
import { planSchema } from './ensureSchema';
import { cellToString, planUpsert } from './upsertPlan';

interface Table {
  header: string[];
  rows: Cell[][];
}

/** Хранилище в памяти: для тестов и --dry-run. Ведёт себя как SheetsStore (те же планы upsert). */
export class MemoryStore implements Store {
  readonly tables = new Map<string, Table>();
  /** Счётчики вызовов — тесты проверяют пакетность. */
  readonly calls = { readMany: 0, upsert: 0, replaceAll: 0 };

  async readMany(sheets: SheetName[]): Promise<Record<SheetName, ReadRow[]>> {
    this.calls.readMany++;
    const out = {} as Record<SheetName, ReadRow[]>;
    for (const s of sheets) out[s] = this.rowsOf(s);
    return out;
  }

  async upsert(sheet: SheetName, rows: Row[], key: readonly string[]): Promise<UpsertResult> {
    this.calls.upsert++;
    const t = this.tables.get(sheet);
    if (!t) throw new Error(`Нет листа ${sheet}. Запустите npm run setup`);
    const plan = planUpsert(t.header, this.rowsOf(sheet), rows, key);
    for (const u of plan.updates) t.rows[u.index] = u.values;
    t.rows.push(...plan.appends);
    return { inserted: plan.appends.length, updated: plan.updates.length };
  }

  async replaceAll(sheet: SheetName, header: string[], rows: Cell[][]): Promise<void> {
    this.calls.replaceAll++;
    this.tables.set(sheet, { header: [...header], rows: rows.map((r) => [...r]) });
  }

  async ensureSchema(seedKeywords: Row[]): Promise<SetupReport> {
    const headers: Partial<Record<SheetName, string[]>> = {};
    for (const [name, t] of this.tables) headers[name as SheetName] = t.header;
    const ch = planSchema(
      {
        sheets: new Set(this.tables.keys()),
        headers,
        settingsKeys: new Set(this.rowsOf('Settings').map((r) => r.key ?? '')),
        keywordsCount: this.rowsOf('Keywords').length,
      },
      seedKeywords,
    );
    for (const name of ch.newSheets) this.tables.set(name, { header: [], rows: [] });
    for (const [name, header] of Object.entries(ch.headerWrites)) {
      const t = this.tables.get(name)!;
      t.header = header;
      t.rows = t.rows.map((r) => header.map((_, i) => r[i] ?? ''));
    }
    if (ch.settingsRows.length) await this.upsert('Settings', ch.settingsRows, SHEET_KEYS.Settings);
    if (ch.keywordRows.length) await this.upsert('Keywords', ch.keywordRows, SHEET_KEYS.Keywords);
    return ch.report;
  }

  publicUrl(): string {
    return 'memory://dry-run';
  }

  /** Для тестов и отладки. */
  rowsOf(sheet: SheetName | string): ReadRow[] {
    const t = this.tables.get(sheet);
    if (!t) return [];
    return t.rows.map((r) => Object.fromEntries(t.header.map((h, i) => [h, cellToString(r[i])])));
  }
}
