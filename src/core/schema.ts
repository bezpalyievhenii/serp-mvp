// Контракт листов Google Sheets. Код читает колонки по имени заголовка, а не по позиции.

export const SHEETS = {
  Keywords: ['id', 'keyword', 'cluster', 'active', 'added_at'],
  SERP: ['run_date', 'keyword_id', 'keyword', 'position', 'url', 'normalized_url', 'domain', 'title'],
  Sites: [
    'url', 'domain', 'first_seen', 'last_seen', 'best_position', 'keywords', 'fetch_status',
    'page_type', 'is_relevant', 'confidence', 'reason', 'brands', 'brand_evidence',
    'contact_type', 'contact_value', 'contact_source', 'labeled_at', 'model', 'prompt_version',
    'affiliate_targets',
  ],
  // Широкий формат: после этих колонок идёт по колонке на каждую дату прогона.
  History: ['keyword', 'normalized_url', 'domain'],
  Runs: [
    'run_id', 'run_date', 'started_at', 'finished_at', 'status', 'keywords_ok', 'keywords_failed',
    'serp_requests', 'urls_new', 'urls_labeled', 'fetch_failed', 'input_tokens', 'output_tokens',
    'cost_usd', 'error',
  ],
  Settings: ['key', 'value', 'description'],
} as const;

export type SheetName = keyof typeof SHEETS;
export const SHEET_NAMES = Object.keys(SHEETS) as SheetName[];

/** Уникальные ключи листов для upsert. */
export const SHEET_KEYS = {
  Keywords: ['id'],
  SERP: ['run_date', 'keyword_id', 'position'],
  Sites: ['url'],
  Runs: ['run_id'],
  Settings: ['key'],
} as const satisfies Partial<Record<SheetName, readonly string[]>>;

export const SETTINGS_DEFAULTS: Record<string, { value: string; description: string }> = {
  schedule_cron: { value: '0 7 * * *', description: 'Ежедневный прогон, 07:00 по timezone' },
  // По умолчанию выключено: автозапуск тратит SERP-квоту и деньги на LLM, включает менеджер сам.
  schedule_enabled: { value: 'FALSE', description: 'Автозапуск по расписанию: TRUE — включён, FALSE — только вручную' },
  timezone: { value: 'America/Toronto', description: 'Часовой пояс дат прогона и расписания' },
  relabel_days: { value: '30', description: 'Через сколько дней переразмечать URL' },
  max_run_cost_usd: { value: '2', description: 'Лимит расходов на LLM за прогон' },
  lock_run_id: { value: '', description: 'Служебное: id идущего прогона' },
  lock_expires_at: { value: '', description: 'Служебное: когда истекает блокировка' },
};
