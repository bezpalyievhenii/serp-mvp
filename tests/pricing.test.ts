import { describe, expect, it } from 'vitest';
import { costUsd } from '../src/adapters/llm/pricing';

describe('стоимость по usage', () => {
  it('Haiku 5.5: 3000 in + 300 out', () => {
    expect(costUsd('claude-haiku-5-5', { input_tokens: 3000, output_tokens: 300 })).toBeCloseTo(0.00045, 8);
  });
  it('Sonnet 5.5 в 20 раз дороже на том же usage', () => {
    const h = costUsd('claude-haiku-5-5', { input_tokens: 3000, output_tokens: 300 });
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 3000, output_tokens: 300 }) / h).toBeCloseTo(20, 5);
  });
  it('кеш считается по своим ценам', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 })).toBeCloseTo((100 * 2 + 2000 * 0.1) / 1e6, 10);
  });
  it('Haiku: промпт > 100K — длинные цены', () => {
    expect(costUsd('claude-haiku-5-5', { input_tokens: 120_000, output_tokens: 0 })).toBeCloseTo(0.06, 8);
  });
  it('неизвестная модель — ошибка', () => {
    expect(() => costUsd('claude-x', { input_tokens: 1, output_tokens: 1 })).toThrow('Нет цены');
  });
});
