// Цены Anthropic, USD за 1M токенов. Сверено 2026-11-10 по https://platform.claude.com/docs/en/about-claude/pricing
// Стоимость прогона считает код по реальному usage из ответов API — оценки модели не используются.

export const PRICES_CHECKED_AT = '2026-11-10';

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheRead: number;
  /** Порог длины промпта, выше которого действует longContext (только Haiku 5.5). */
  longContextThreshold?: number;
  longContext?: Omit<ModelPrice, 'longContextThreshold' | 'longContext'>;
}

export const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.1 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheWrite5m: 0.125,
    cacheRead: 0.01,
    longContextThreshold: 100_000,
    longContext: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheRead: 0.05 },
  },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Стоимость одного ответа API. Неизвестная модель — ошибка: тихо считать по нулям нельзя. */
export function costUsd(model: string, u: Usage): number {
  const base = PRICES[model];
  if (!base) throw new Error(`Нет цены для модели ${model}: добавьте её в src/adapters/llm/pricing.ts`);
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const promptTokens = u.input_tokens + write + read;
  const p = base.longContextThreshold && base.longContext && promptTokens > base.longContextThreshold ? base.longContext : base;
  return (u.input_tokens * p.input + u.output_tokens * p.output + write * p.cacheWrite5m + read * p.cacheRead) / 1_000_000;
}
