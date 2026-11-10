import { sleep } from './time';

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  isRetryable: (err: unknown) => boolean;
  /** Подменяется в тестах. */
  sleepFn?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Экспоненциальная пауза со случайным разбросом (full jitter). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const wait = opts.sleepFn ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts || !opts.isRetryable(err)) throw err;
      const delay = Math.round(Math.random() * opts.baseMs * 2 ** (attempt - 1));
      opts.onRetry?.(err, attempt, delay);
      await wait(delay);
    }
  }
}
