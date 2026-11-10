import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const ROOT = resolve(import.meta.dirname, '..');
export const ENV_FILE = resolve(ROOT, '.env');
export const CACHE_DIR = resolve(ROOT, 'cache', 'serp');
export const SEED_FILE = resolve(ROOT, 'data', 'keywords.csv');
export const FIXTURES_DIR = resolve(ROOT, 'tests', 'fixtures');
export const PROMPT_FILE = resolve(ROOT, 'prompts', 'classify.md');
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const opt = z
  .string()
  .optional()
  .transform((s) => (s ?? '').trim());

const EnvSchema = z.object({
  SERP_PROVIDER: z
    .string()
    .optional()
    .transform((s) => (s ?? '').trim() || 'searchapi')
    .pipe(z.enum(['searchapi', 'hasdata'])),
  SEARCHAPI_KEY: opt,
  HASDATA_KEY: opt,
  ANTHROPIC_API_KEY: opt,
  LLM_MODEL: opt,
  GOOGLE_SHEET_ID: opt,
  GOOGLE_APPLICATION_CREDENTIALS: opt,
});
export type Env = z.infer<typeof EnvSchema>;

/** Читает .env (встроенный в Node загрузчик) и валидирует переменные. Ничего не печатает. */
export function loadEnv(): { env: Env; envFileFound: boolean; error?: string } {
  const envFileFound = existsSync(ENV_FILE);
  if (envFileFound) process.loadEnvFile(ENV_FILE);
  const p = EnvSchema.safeParse(process.env);
  if (!p.success) {
    return {
      env: EnvSchema.parse({ ...process.env, SERP_PROVIDER: 'searchapi' }),
      envFileFound,
      error: `SERP_PROVIDER должен быть searchapi или hasdata, сейчас «${process.env.SERP_PROVIDER}»`,
    };
  }
  return { env: p.data, envFileFound };
}

export function serpKey(env: Env): { name: string; value: string } {
  return env.SERP_PROVIDER === 'hasdata'
    ? { name: 'HASDATA_KEY', value: env.HASDATA_KEY }
    : { name: 'SEARCHAPI_KEY', value: env.SEARCHAPI_KEY };
}

/** Проверка обязательных переменных для боевого прогона. Возвращает список проблем. */
export function missingForRun(env: Env): string[] {
  const out: string[] = [];
  const k = serpKey(env);
  if (!k.value) out.push(`${k.name} пуст (SERP_PROVIDER=${env.SERP_PROVIDER})`);
  if (!env.GOOGLE_SHEET_ID) out.push('GOOGLE_SHEET_ID пуст');
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) out.push('GOOGLE_APPLICATION_CREDENTIALS пуст');
  else if (!existsSync(env.GOOGLE_APPLICATION_CREDENTIALS))
    out.push(`Файл ключа сервисного аккаунта не найден: ${env.GOOGLE_APPLICATION_CREDENTIALS}`);
  return out;
}
