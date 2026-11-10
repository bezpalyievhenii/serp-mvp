import { z } from 'zod';

/** Единая схема выдачи: ядро не знает, какой провайдер её вернул. */
export const SerpItemSchema = z.object({
  position: z.number().int().min(1).max(10),
  url: z.url(),
  title: z.string(),
  snippet: z.string(),
});
export type SerpItem = z.infer<typeof SerpItemSchema>;

export const SerpResultSchema = z.object({
  query: z.string(),
  provider: z.string(),
  items: z.array(SerpItemSchema).max(10),
  /** Сколько платных запросов к провайдеру ушло (1 или 2). */
  requests: z.number().int().min(0),
  pagesFetched: z.number().int().min(0),
});
export type SerpResult = z.infer<typeof SerpResultSchema>;

const boolish = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.enum(['TRUE', 'FALSE', '']))
  .transform((s) => s !== 'FALSE');

export const KeywordSchema = z.object({
  id: z.string().min(1),
  keyword: z.string().min(1),
  cluster: z.string().default(''),
  active: boolish,
  added_at: z.string().default(''),
});
export type Keyword = z.infer<typeof KeywordSchema>;

export const SettingsSchema = z.object({
  schedule_cron: z.string().default('0 7 * * *'),
  /** Нет ключа или пусто — выключено. */
  schedule_enabled: z
    .string()
    .default('FALSE')
    .transform((s) => s.trim().toUpperCase() === 'TRUE'),
  timezone: z.string().default('America/Toronto'),
  relabel_days: z.coerce.number().int().min(0).default(30),
  max_run_cost_usd: z.coerce.number().min(0).default(2),
  lock_run_id: z.string().default(''),
  lock_expires_at: z.string().default(''),
});
export type Settings = z.infer<typeof SettingsSchema>;

export type RunStatus = 'ok' | 'partial' | 'failed';

export interface RunSummary {
  run_id: string;
  run_date: string;
  started_at: string;
  finished_at: string;
  status: RunStatus;
  keywords_ok: number;
  keywords_failed: number;
  serp_requests: number;
  urls_new: number;
  urls_labeled: number;
  fetch_failed: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string;
}
