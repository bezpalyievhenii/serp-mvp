import { loadEnv, missingForRun } from '../../config';
import { isEmptyReport } from '../../adapters/store/ensureSchema';
import { LockBusyError } from '../../core/lock';
import { runPipeline } from '../../core/runPipeline';
import { dateInTz } from '../../core/time';
import { MemoryStore } from '../../adapters/store/memoryStore';
import { buildLabeling, buildMemoryStore, buildSerp, buildSheetsStore, consoleLogger as log, seedKeywords, type SerpMode } from '../wiring';
import { doctor } from './doctor';
import { serve } from './serve';
import { exportResults } from './export';

const HELP = `Использование:
  npm run doctor                проверить .env, доступ к таблице и ключи
  npm run setup                 создать/дополнить листы, заголовки, настройки и стартовые ключи
  npm run run                   прогон по активным ключам: ~10–13 SERP-запросов в первый раз за день,
                                повтор в тот же день берёт сегодняшний снимок (0 запросов)
  npm run run -- --from-cache   прогон по сохранённой выдаче из cache/serp (без SERP-запросов)
  npm run run -- --no-label     только выдача, без разметки (без трат на LLM)
  npm run run -- --relabel      переразметить все URL, даже со свежей меткой
  npm run run -- --refresh      запросить выдачу заново, даже если сегодняшний снимок уже есть
  npm run run -- --dry-run      полностью офлайн: память вместо таблицы, выдача из фикстур (или --from-cache)
  npm run export                CSV и XLSX всех листов в results/
  npm run serve                 веб-интерфейс менеджера и расписание (http://localhost:3000)
  npm run serve -- --demo       интерфейс на демо-данных из фикстур, без ключей и без таблицы`;

async function setup(): Promise<number> {
  const { env } = loadEnv();
  const problems = missingForRun(env).filter((p) => !/SEARCHAPI_KEY|HASDATA_KEY/.test(p));
  if (problems.length) {
    problems.forEach((p) => log.error(p));
    log.error('Запустите npm run doctor — он подскажет, что исправить');
    return 1;
  }
  const store = buildSheetsStore(env, log);
  const report = await store.ensureSchema(await seedKeywords(dateInTz(new Date(), 'America/Toronto')));
  if (isEmptyReport(report)) log.info('Таблица в порядке, ничего не изменено');
  if (report.createdSheets.length) log.info(`Созданы листы: ${report.createdSheets.join(', ')}`);
  if (report.addedColumns.length) log.info(`Добавлены колонки: ${report.addedColumns.join(', ')}`);
  if (report.addedSettings.length) log.info(`Добавлены настройки: ${report.addedSettings.join(', ')}`);
  if (report.seededKeywords) log.info(`Залито стартовых ключей: ${report.seededKeywords}`);
  report.warnings.forEach((w) => log.warn(w));
  log.info(`Таблица: ${store.publicUrl()}`);
  return 0;
}

async function run(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const fromCache = args.includes('--from-cache');
  const { env, error } = loadEnv();
  if (error) {
    log.error(error);
    return 1;
  }
  const mode: SerpMode = fromCache ? 'cache' : dryRun ? 'fixture' : args.includes('--refresh') ? 'refresh' : 'live';
  // В --dry-run разметки нет: он полностью офлайн. --no-label — только выдача, без трат на LLM.
  const withLabels = !dryRun && !args.includes('--no-label');
  if (!dryRun) {
    const problems = [
      ...missingForRun(env).filter((p) => mode === 'live' || mode === 'refresh' || !/SEARCHAPI_KEY|HASDATA_KEY/.test(p)),
      ...(withLabels && !env.ANTHROPIC_API_KEY ? ['ANTHROPIC_API_KEY пуст (нужен для разметки; без неё: --no-label)'] : []),
    ];
    if (problems.length) {
      problems.forEach((p) => log.error(p));
      log.error('Запустите npm run doctor — он подскажет, что исправить');
      return 1;
    }
  }
  const store = dryRun ? await buildMemoryStore() : buildSheetsStore(env, log);
  const serp = buildSerp(env, log, mode);
  if (dryRun) log.info(`--dry-run: таблица не меняется, выдача из ${mode === 'cache' ? 'cache/serp' : 'tests/fixtures/serp'}`);
  try {
    const labeling = withLabels ? { ...buildLabeling(env), forceRelabel: args.includes('--relabel') } : undefined;
    if (!withLabels && !dryRun) log.info('--no-label: разметка пропущена');
    const { summary } = await runPipeline({ store, serp, log, labeling });
    if (dryRun && store instanceof MemoryStore) {
      log.info(`dry-run: SERP ${store.rowsOf('SERP').length} строк, Sites ${store.rowsOf('Sites').length}, History ${store.rowsOf('History').length}`);
    } else log.info(`Таблица: ${store.publicUrl()}`);
    return summary.status === 'failed' ? 1 : 0;
  } catch (e) {
    if (e instanceof LockBusyError) {
      log.warn(e.message);
      return 2;
    }
    throw e;
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  let code: number;
  switch (cmd) {
    case 'doctor':
      code = await doctor();
      break;
    case 'setup':
      code = await setup();
      break;
    case 'run':
      code = await run(args);
      break;
    case 'export':
      code = await exportResults();
      break;
    case 'serve':
      await serve(args);
      return; // процесс живёт, пока работает сервер
    default:
      console.log(HELP);
      code = cmd ? 1 : 0;
  }
  process.exit(code);
}

main().catch((e: unknown) => {
  const err = e as Error;
  log.error(err.message ?? String(e));
  if (process.env.DEBUG) console.error(err.stack);
  else log.error('Подробности: DEBUG=1 npm run … ; диагностика настройки: npm run doctor');
  process.exit(1);
});
