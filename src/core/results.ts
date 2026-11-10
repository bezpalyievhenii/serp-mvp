// Производные данные: агрегаты по сайтам и сводка History.
import type { Cell, ReadRow, Row } from './ports';
import { SHEETS } from './schema';

/** Объединяет старые строки SERP с новыми по ключу (run_date, keyword_id, position). */
export function mergeSerp(existing: ReadRow[], fresh: Row[]): ReadRow[] {
  const k = (r: Record<string, unknown>) => `${r.run_date}|${r.keyword_id}|${r.position}`;
  const map = new Map<string, ReadRow>();
  for (const r of existing) if (r.run_date && r.keyword_id) map.set(k(r), r);
  for (const r of fresh) map.set(k(r), Object.fromEntries(Object.entries(r).map(([a, b]) => [a, String(b)])));
  return [...map.values()];
}

/**
 * History в широком формате: keyword × normalized_url → позиция по датам.
 * Строки отсортированы по ключу, затем по позиции в последнюю дату.
 */
export function buildHistory(serp: ReadRow[], keywordText: Map<string, string>): { header: string[]; rows: Cell[][] } {
  const dates = [...new Set(serp.map((r) => r.run_date!).filter(Boolean))].sort();
  const lastDate = dates.at(-1);
  const byKey = new Map<string, { kwId: string; keyword: string; url: string; domain: string; pos: Map<string, number> }>();
  for (const r of serp) {
    if (!r.normalized_url) continue;
    const key = `${r.keyword_id}|${r.normalized_url}`;
    let e = byKey.get(key);
    if (!e) {
      e = {
        kwId: r.keyword_id ?? '',
        keyword: keywordText.get(r.keyword_id ?? '') ?? r.keyword ?? '',
        url: r.normalized_url,
        domain: r.domain ?? '',
        pos: new Map(),
      };
      byKey.set(key, e);
    }
    const p = Number(r.position);
    const prev = e.pos.get(r.run_date!);
    if (Number.isFinite(p) && (prev === undefined || p < prev)) e.pos.set(r.run_date!, p);
  }
  const rows = [...byKey.values()].sort(
    (a, b) =>
      a.kwId.localeCompare(b.kwId) ||
      (a.pos.get(lastDate ?? '') ?? 99) - (b.pos.get(lastDate ?? '') ?? 99) ||
      a.url.localeCompare(b.url),
  );
  return {
    header: [...SHEETS.History, ...dates],
    rows: rows.map((e) => [e.keyword, e.url, e.domain, ...dates.map((d) => e.pos.get(d) ?? '')]),
  };
}

/** Данные для интерфейса: сайты, история выдачи и прогоны. */
export async function loadResults(store: import('./ports').Store) {
  const d = await store.readMany(['Sites', 'SERP', 'Runs', 'Keywords']);
  return {
    sites: d.Sites.filter((r) => r.url),
    serp: d.SERP.filter((r) => r.run_date && r.normalized_url),
    runs: d.Runs.filter((r) => r.run_id).reverse(),
    keywords: d.Keywords.filter((r) => r.id),
  };
}
