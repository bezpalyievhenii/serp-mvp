// Сервис ключей: менеджер добавляет, правит и выключает ключи. Удаления нет — только active=FALSE.
import type { Store } from './ports';
import { parseKeywords } from './repo';
import { SHEET_KEYS } from './schema';
import { dateInTz } from './time';
import type { Keyword } from './types';

export async function listKeywords(store: Store): Promise<Keyword[]> {
  return parseKeywords((await store.readMany(['Keywords'])).Keywords);
}

export function nextKeywordId(existing: Keyword[]): string {
  const max = existing.reduce((m, k) => Math.max(m, Number(/^k(\d+)$/.exec(k.id)?.[1] ?? 0)), 0);
  return `k${String(max + 1).padStart(2, '0')}`;
}

export class KeywordError extends Error {}

export async function addKeyword(
  store: Store,
  input: { keyword: string; cluster?: string },
  now: Date,
  timezone: string,
): Promise<Keyword> {
  const text = input.keyword.trim();
  if (!text) throw new KeywordError('empty_keyword');
  const all = await listKeywords(store);
  if (all.some((k) => k.keyword.toLowerCase() === text.toLowerCase())) throw new KeywordError('duplicate_keyword');
  const kw: Keyword = { id: nextKeywordId(all), keyword: text, cluster: (input.cluster ?? '').trim(), active: true, added_at: dateInTz(now, timezone) };
  await store.upsert('Keywords', [{ ...kw }], SHEET_KEYS.Keywords);
  return kw;
}

export async function updateKeyword(
  store: Store,
  id: string,
  patch: { keyword?: string; cluster?: string; active?: boolean },
): Promise<Keyword> {
  const all = await listKeywords(store);
  const cur = all.find((k) => k.id === id);
  if (!cur) throw new KeywordError('not_found');
  const next: Keyword = {
    ...cur,
    ...(patch.keyword !== undefined ? { keyword: patch.keyword.trim() } : {}),
    ...(patch.cluster !== undefined ? { cluster: patch.cluster.trim() } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  };
  if (!next.keyword) throw new KeywordError('empty_keyword');
  if (all.some((k) => k.id !== id && k.keyword.toLowerCase() === next.keyword.toLowerCase())) throw new KeywordError('duplicate_keyword');
  // id не меняется никогда: на нём держится история.
  await store.upsert('Keywords', [{ id, keyword: next.keyword, cluster: next.cluster, active: next.active }], SHEET_KEYS.Keywords);
  return next;
}
