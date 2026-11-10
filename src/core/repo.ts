// Перевод строк хранилища в доменные объекты (с валидацией zod) и обратно.
import type { ReadRow, Row } from './ports';
import { KeywordSchema, SettingsSchema, type Keyword, type Settings } from './types';

export function parseKeywords(rows: ReadRow[], warn?: (m: string) => void): Keyword[] {
  const out: Keyword[] = [];
  rows.forEach((r, i) => {
    if (!r.id && !r.keyword) return; // пустая строка
    const p = KeywordSchema.safeParse(r);
    if (p.success) out.push(p.data);
    else warn?.(`Keywords, строка ${i + 2}: пропущена (${p.error.issues.map((x) => x.path.join('.') + ' ' + x.message).join('; ')})`);
  });
  return out;
}

export function settingsMap(rows: ReadRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((r) => r.key).map((r) => [r.key!, r.value ?? '']));
}

export function parseSettings(rows: ReadRow[]): Settings {
  const m = settingsMap(rows);
  // Пустые строки → значения по умолчанию. Исключения: служебная блокировка и schedule_cron (пусто = расписание выключено).
  const keepEmpty = (k: string) => k.startsWith('lock_') || k === 'schedule_cron';
  const clean = Object.fromEntries(Object.entries(m).filter(([k, v]) => v !== '' || keepEmpty(k)));
  return SettingsSchema.parse(clean);
}

export const settingRows = (patch: Record<string, string>): Row[] =>
  Object.entries(patch).map(([key, value]) => ({ key, value }));

/** Простой CSV-парсер (кавычки и запятые внутри кавычек поддерживаются) для data/keywords.csv. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), lines.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell !== '' || row.length) row.push(cell), lines.push(row);
  const [header, ...data] = lines.filter((l) => l.some((x) => x.trim() !== ''));
  if (!header) return [];
  return data.map((l) => Object.fromEntries(header.map((h, i) => [h.trim(), (l[i] ?? '').trim()])));
}
