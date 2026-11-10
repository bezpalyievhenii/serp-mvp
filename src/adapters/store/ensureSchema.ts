import type { Row, SetupReport } from '../../core/ports';
import { SETTINGS_DEFAULTS, SHEETS, SHEET_NAMES, type SheetName } from '../../core/schema';

/** Текущее состояние хранилища, нужное для setup. */
export interface SchemaSnapshot {
  sheets: Set<string>;
  headers: Partial<Record<SheetName, string[]>>;
  settingsKeys: Set<string>;
  keywordsCount: number;
}

export interface SchemaChanges {
  report: SetupReport;
  newSheets: SheetName[];
  /** Итоговые заголовки листов, которые нужно записать (только изменённые). */
  headerWrites: Partial<Record<SheetName, string[]>>;
  settingsRows: Row[];
  keywordRows: Row[];
}

/**
 * Решает, что дописать: недостающие листы, недостающие колонки (в конец, порядок не трогаем),
 * недостающие ключи настроек и стартовые ключи, если лист Keywords пуст.
 */
export function planSchema(snap: SchemaSnapshot, seedKeywords: Row[]): SchemaChanges {
  const report: SetupReport = { createdSheets: [], addedColumns: [], addedSettings: [], seededKeywords: 0, warnings: [] };
  const changes: SchemaChanges = { report, newSheets: [], headerWrites: {}, settingsRows: [], keywordRows: [] };

  for (const name of SHEET_NAMES) {
    const expected = [...SHEETS[name]];
    if (!snap.sheets.has(name)) {
      changes.newSheets.push(name);
      report.createdSheets.push(name);
    }
    const current = (snap.headers[name] ?? []).filter((h) => h !== '');
    const missing = expected.filter((h) => !current.includes(h));
    if (missing.length) {
      if (name === 'History' && current.length > 0) {
        // History перестраивается кодом целиком — заголовок поправит первый прогон.
        report.warnings.push(`History: нет колонок ${missing.join(', ')} — лист перестроится при прогоне`);
        continue;
      }
      changes.headerWrites[name] = [...current, ...missing];
      report.addedColumns.push(...missing.map((m) => `${name}.${m}`));
    }
  }

  for (const [key, def] of Object.entries(SETTINGS_DEFAULTS)) {
    if (!snap.settingsKeys.has(key)) {
      changes.settingsRows.push({ key, value: def.value, description: def.description });
      report.addedSettings.push(key);
    }
  }

  if (snap.keywordsCount === 0) {
    changes.keywordRows = seedKeywords;
    report.seededKeywords = seedKeywords.length;
  }
  return changes;
}

export const isEmptyReport = (r: SetupReport) =>
  !r.createdSheets.length && !r.addedColumns.length && !r.addedSettings.length && !r.seededKeywords;
