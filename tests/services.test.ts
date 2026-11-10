import { describe, expect, it } from 'vitest';
import { KeywordError, addKeyword, listKeywords, nextKeywordId, updateKeyword } from '../src/core/keywords';
import { SettingsError, describeCron, getSettings, setSchedule } from '../src/core/settings';
import { freshStore } from './helpers';

const now = new Date('2026-11-10T15:00:00Z');

describe('сервис ключей', () => {
  it('добавляет ключ со следующим id и датой по Торонто', async () => {
    const store = await freshStore(10);
    const kw = await addKeyword(store, { keyword: '  best payout casino canada ', cluster: 'Платёжки' }, now, 'America/Toronto');
    expect(kw).toMatchObject({ id: 'k11', keyword: 'best payout casino canada', active: true, added_at: '2026-11-10' });
    expect(await listKeywords(store)).toHaveLength(11);
  });

  it('дубль и пустая фраза отклоняются', async () => {
    const store = await freshStore(2);
    await expect(addKeyword(store, { keyword: 'KEYWORD 1' }, now, 'America/Toronto')).rejects.toThrow(KeywordError);
    await expect(addKeyword(store, { keyword: '  ' }, now, 'America/Toronto')).rejects.toThrow('empty_keyword');
  });

  it('правка и выключение не меняют id и не удаляют строку', async () => {
    const store = await freshStore(3);
    await updateKeyword(store, 'k02', { keyword: 'new text', active: false });
    const k = (await listKeywords(store)).find((x) => x.id === 'k02')!;
    expect(k).toMatchObject({ keyword: 'new text', active: false });
    expect(store.rowsOf('Keywords')).toHaveLength(3);
    expect(store.rowsOf('Keywords')[1]!.active).toBe('FALSE');
  });

  it('nextKeywordId идёт после максимального', () => {
    expect(nextKeywordId([{ id: 'k02' }, { id: 'k17' }, { id: 'custom' }] as never)).toBe('k18');
  });
});

describe('расписание', () => {
  it('сохраняет корректный cron в Settings', async () => {
    const store = await freshStore(1);
    await setSchedule(store, '0 8 * * 1-5');
    expect((await getSettings(store)).schedule_cron).toBe('0 8 * * 1-5');
  });

  it('неверный cron отклоняется, пустой — выключает расписание', async () => {
    const store = await freshStore(1);
    await expect(setSchedule(store, '61 * * *')).rejects.toThrow(SettingsError);
    await setSchedule(store, '');
    expect((await getSettings(store)).schedule_cron).toBe('');
  });

  it('ближайшие запуски считаются в часовом поясе', () => {
    const p = describeCron('0 7 * * *', 'America/Toronto', 2);
    expect(p.valid).toBe(true);
    expect(p.next).toHaveLength(2);
    // 07:00 в Торонто зимой = 12:00 UTC
    expect(new Date(p.next[0]!).getUTCHours()).toBe(12);
  });
});
