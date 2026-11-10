import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { ENV_FILE, ROOT, loadEnv, serpKey } from '../../config';
import { googleStatus } from '../../adapters/store/sheetsStore';
import { SHEETS, SHEET_NAMES } from '../../core/schema';
import { buildPageSource, buildSheetsStore } from '../wiring';

type Status = 'ok' | 'warn' | 'fail';
const results: { status: Status; title: string; fix?: string }[] = [];
const mark = { ok: '✓', warn: '⚠', fail: '✗' };

function report(status: Status, title: string, fix?: string) {
  results.push({ status, title, fix });
  console.log(`${mark[status]} ${title}`);
  if (fix) console.log(`    → ${fix}`);
}

const silentLog = { info() {}, warn() {}, error() {} };

/**
 * Проверяет настройку и печатает, что исправить. Платные запросы не тратит:
 * SERP — эндпоинт остатка кредитов, Anthropic — GET /v1/models/{id}, Sheets — чтение и перезапись одной ячейки тем же значением.
 */
export async function doctor(): Promise<number> {
  console.log('npm run doctor — проверка настройки\n');

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) report('ok', `Node.js ${process.versions.node}`);
  else report('fail', `Node.js ${process.versions.node}`, 'Нужен Node.js 22 LTS или новее: https://nodejs.org');

  const { env, envFileFound, error } = loadEnv();
  if (!envFileFound) {
    report('fail', '.env не найден', 'Скопируйте шаблон: cp .env.example .env и заполните ключи');
    return finish();
  }
  report('ok', '.env найден');
  if (error) report('fail', error, 'Исправьте SERP_PROVIDER в .env');

  // --- Google Sheets ---
  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  let saEmail = '<email сервисного аккаунта>';
  let saProject = '';
  let credsOk = false;
  if (!credPath) report('fail', 'GOOGLE_APPLICATION_CREDENTIALS пуст', 'Укажите абсолютный путь к JSON-ключу сервисного аккаунта');
  else if (!isAbsolute(credPath)) report('fail', `Путь к ключу не абсолютный: ${credPath}`, 'Укажите полный путь, например /Users/you/keys/serp-mvp-sa.json (~ не раскрывается)');
  else if (!existsSync(credPath))
    report('fail', `JSON-ключ сервисного аккаунта не найден: ${credPath}`, 'Google Cloud Console → IAM → Service Accounts → Keys → Add key → JSON; положите файл по этому пути');
  else {
    try {
      const j = JSON.parse(readFileSync(credPath, 'utf8')) as { type?: string; client_email?: string; project_id?: string };
      if (j.type !== 'service_account' || !j.client_email) throw new Error('не ключ сервисного аккаунта');
      saEmail = j.client_email;
      saProject = j.project_id ?? '';
      credsOk = true;
      report('ok', `Сервисный аккаунт: ${saEmail}`);
      if (!relative(ROOT, credPath).startsWith('..'))
        report('warn', 'JSON-ключ лежит внутри репозитория', 'Перенесите его вне папки проекта, чтобы он не попал в git');
    } catch (e) {
      report('fail', `JSON-ключ не читается: ${(e as Error).message}`, 'Скачайте ключ заново в формате JSON');
    }
  }

  if (!env.GOOGLE_SHEET_ID) report('fail', 'GOOGLE_SHEET_ID пуст', 'Возьмите ID из адреса таблицы: docs.google.com/spreadsheets/d/<ID>/edit');
  else if (credsOk) {
    const store = buildSheetsStore(env, silentLog);
    try {
      const meta = await store.meta();
      report('ok', `Таблица доступна: «${meta.properties?.title}»`);
      const titles = new Set((meta.sheets ?? []).map((s) => s.properties?.title));
      const missingSheets = SHEET_NAMES.filter((n) => !titles.has(n));
      const present = SHEET_NAMES.filter((n) => titles.has(n));
      if (present.length) await store.readMany(present);
      const headerProblems: string[] = [];
      for (const n of present) {
        const header = store.headerOf(n);
        const miss = SHEETS[n].filter((h) => !header.includes(h));
        if (miss.length) headerProblems.push(`${n}: ${miss.join(', ')}`);
      }
      if (missingSheets.length || headerProblems.length)
        report('warn', `Структура таблицы неполная: ${[...missingSheets.map((s) => `нет листа ${s}`), ...headerProblems].join('; ')}`, 'Запустите npm run setup');
      else report('ok', 'Листы и заголовки на месте');
      if (titles.has('Settings')) {
        await store.checkWrite();
        report('ok', 'Право на запись есть');
      }
    } catch (e) {
      report('fail', `Google Sheets: ${googleMessage(e)}`, googleFix(e, saEmail, saProject));
    }
  }

  // --- SERP ---
  const k = serpKey(env);
  if (!k.value) report('fail', `${k.name} пуст (SERP_PROVIDER=${env.SERP_PROVIDER})`, env.SERP_PROVIDER === 'hasdata' ? 'Ключ: https://app.hasdata.com/dashboard' : 'Ключ: https://www.searchapi.io → Dashboard → API Key');
  else {
    try {
      const acc = await buildPageSource(env).account?.();
      if (acc?.remaining === null || acc?.remaining === undefined) report('ok', `${env.SERP_PROVIDER}: ключ принят (${acc?.details ?? ''})`);
      else if (acc.remaining < 20)
        report('warn', `${env.SERP_PROVIDER}: осталось ~${acc.remaining} запросов (${acc.details})`, 'Прогон тратит 10–20 запросов. Переключите SERP_PROVIDER или пополните квоту');
      else report('ok', `${env.SERP_PROVIDER}: осталось ~${acc.remaining} запросов (${acc.details})`);
    } catch (e) {
      report('fail', `${env.SERP_PROVIDER}: ${(e as Error).message}`, `Проверьте ${k.name} в .env`);
    }
  }

  // --- Anthropic ---
  if (!env.ANTHROPIC_API_KEY) report('fail', 'ANTHROPIC_API_KEY пуст', 'Ключ: https://console.anthropic.com → Settings → API Keys');
  else if (!env.LLM_MODEL) report('fail', 'LLM_MODEL пуст', 'Укажите ID модели Sonnet, см. .env.example');
  else {
    try {
      const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(env.LLM_MODEL)}`, {
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) report('ok', `Anthropic: ключ принят, модель ${env.LLM_MODEL} доступна`);
      else if (res.status === 401) report('fail', 'Anthropic: ключ отклонён (401)', 'Создайте новый ключ в console.anthropic.com и вставьте в ANTHROPIC_API_KEY');
      else if (res.status === 404) report('fail', `Anthropic: модель ${env.LLM_MODEL} не найдена`, 'Проверьте LLM_MODEL: актуальные ID — docs.claude.com → Models');
      else report('fail', `Anthropic: HTTP ${res.status}`, 'Проверьте ключ и баланс в console.anthropic.com');
    } catch (e) {
      report('fail', `Anthropic: нет связи (${(e as Error).message})`, 'Проверьте интернет');
    }
  }

  return finish();
}

function googleMessage(e: unknown): string {
  const s = googleStatus(e);
  const msg = (e as Error).message ?? String(e);
  return s ? `HTTP ${s}: ${msg}` : msg;
}

function googleFix(e: unknown, saEmail: string, project: string): string {
  const s = googleStatus(e);
  const msg = String((e as Error).message ?? '');
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg))
    return `Включите Google Sheets API: https://console.cloud.google.com/apis/library/sheets.googleapis.com${project ? `?project=${project}` : ''}`;
  if (/invalid_grant|account not found/i.test(msg)) return 'Ключ сервисного аккаунта отозван или часы компьютера сбиты. Скачайте новый JSON-ключ';
  if (s === 403) return `Расшарьте таблицу на ${saEmail} с правом редактора (Настройки доступа → добавить email → Редактор)`;
  if (s === 404) return 'Таблица не найдена: проверьте GOOGLE_SHEET_ID в .env';
  return 'Проверьте интернет и повторите npm run doctor';
}

function finish(): number {
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log(`\n${fails ? '✗' : '✓'} Ошибок: ${fails}, предупреждений: ${warns}${fails ? '' : '. Можно запускать npm run setup и npm run run'}`);
  console.log(`  (.env: ${ENV_FILE})`);
  return fails ? 1 : 0;
}
