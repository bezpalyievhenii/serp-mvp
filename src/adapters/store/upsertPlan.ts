import type { Cell, ReadRow, Row } from '../../core/ports';

export const cellToString = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
};

export const keyOf = (row: Record<string, unknown>, key: readonly string[]): string =>
  key.map((k) => cellToString(row[k])).join('\u0001');

export interface UpsertPlan {
  /** Индекс строки данных (0 = первая строка после заголовка) → полная новая строка по заголовку. */
  updates: { index: number; values: Cell[] }[];
  appends: Cell[][];
}

/**
 * Чистая функция, общая для всех хранилищ: что обновить и что добавить.
 * Обновление сливает новые поля поверх существующих, поэтому колонки,
 * которые код не трогает (например, ручные пометки), не стираются.
 * Повторяющиеся ключи во входе схлопываются (побеждает последний).
 */
export function planUpsert(
  header: string[],
  existing: ReadRow[],
  rows: Row[],
  key: readonly string[],
): UpsertPlan {
  const index = new Map<string, number>();
  existing.forEach((r, i) => {
    const k = keyOf(r, key);
    if (!index.has(k)) index.set(k, i);
  });

  const merged = new Map<string, { index: number | null; row: Record<string, Cell> }>();
  for (const row of rows) {
    const k = keyOf(row, key);
    const prev = merged.get(k);
    if (prev) {
      Object.assign(prev.row, row);
      continue;
    }
    const i = index.get(k);
    merged.set(k, { index: i ?? null, row: i === undefined ? { ...row } : { ...existing[i], ...row } });
  }

  const toValues = (r: Record<string, Cell>): Cell[] => header.map((h) => r[h] ?? '');
  const plan: UpsertPlan = { updates: [], appends: [] };
  for (const { index: i, row } of merged.values()) {
    if (i === null) plan.appends.push(toValues(row));
    else plan.updates.push({ index: i, values: toValues(row) });
  }
  return plan;
}
