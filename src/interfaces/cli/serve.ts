import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURES_DIR, loadEnv, missingForRun } from '../../config';
import { SHEET_KEYS } from '../../core/schema';
import { runPipeline } from '../../core/runPipeline';
import type { Row } from '../../core/ports';
import { startServer } from '../http/server';
import { buildLabeling, buildMemoryStore, buildSerp, buildSheetsStore, consoleLogger as log } from '../wiring';

/**
 * npm run serve — интерфейс над боевой таблицей.
 * npm run serve -- --demo — интерфейс над памятью: выдача из фикстур за 3 дня и демо-метки.
 * Ни ключей, ни таблицы демо-режим не трогает.
 */
export async function serve(args: string[]) {
  const demo = args.includes('--demo');
  const port = Number(process.env.PORT ?? 3000);
  const { env } = loadEnv();

  if (demo) {
    const store = await buildMemoryStore();
    const serp = buildSerp(env, log, 'fixture');
    const quiet = { info() {}, warn() {}, error: log.error };
    const day = 24 * 3600_000;
    for (const back of [2, 1, 0]) {
      await runPipeline({ store, serp, log: quiet, now: () => new Date(Date.now() - back * day) });
    }
    const { labels } = JSON.parse(await readFile(join(FIXTURES_DIR, 'demo', 'labels.json'), 'utf8')) as { labels: Row[] };
    await store.upsert('Sites', labels, SHEET_KEYS.Sites);
    log.info('Демо-данные: 3 прогона по фикстурам и примеры меток');
    await startServer({ store, serp, log, port, demo: true, provider: `${env.SERP_PROVIDER} (fixture)` });
    return;
  }

  const problems = missingForRun(env);
  if (problems.length) {
    problems.forEach((p) => log.error(p));
    log.error('Для просмотра без ключей: npm run serve -- --demo. Диагностика: npm run doctor');
    process.exit(1);
  }
  const labeling = env.ANTHROPIC_API_KEY ? buildLabeling(env) : undefined;
  if (!labeling) log.warn('ANTHROPIC_API_KEY пуст: прогоны из интерфейса будут без разметки');
  await startServer({ store: buildSheetsStore(env, log), serp: buildSerp(env, log, 'live'), labeling, log, port, demo: false, provider: env.SERP_PROVIDER });
}
