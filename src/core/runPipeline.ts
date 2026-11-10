import { randomBytes } from 'node:crypto';
import { acquireLock, releaseLock } from './lock';
import { domainOf, normalizeUrl } from './normalize';
import { labelSites, needsLabel, type SiteToLabel } from './labeling';
import { SerpError, type Labeler, type Logger, type PageReader, type ReadRow, type Row, type SerpProvider, type Store } from './ports';
import { parseKeywords, parseSettings } from './repo';
import { buildHistory, mergeSerp } from './results';
import { SHEET_KEYS } from './schema';
import { dateInTz, dateTimeInTz } from './time';
import type { Keyword, RunStatus, RunSummary, SerpResult } from './types';

export interface PipelineDeps {
  store: Store;
  serp: SerpProvider;
  log: Logger;
  now?: () => Date;
  /** Разметка URL (В2). Без неё прогон только собирает выдачу (тесты, --dry-run, демо). */
  labeling?: { reader: PageReader; labeler: Labeler; forceRelabel?: boolean };
  /** Вызывается, когда блокировка взята и прогон точно пошёл (для кнопки «Запустить сейчас»). */
  onStarted?: (runId: string) => void;
}

/** То, что разметке (В2) понадобится о сайте из сегодняшней выдачи. */
export interface SiteContext {
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string;
  snippet: string;
}

export interface PipelineResult {
  summary: RunSummary;
  sites: Map<string, SiteContext>;
}

const ERROR_LIMIT = 1000;

/**
 * Один прогон: блокировка → ключи → выдача → SERP/Sites → History → Runs.
 * Падение одного ключа не роняет прогон (статус partial).
 * Если блокировка занята, бросает LockBusyError, и строка в Runs не пишется.
 */
export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { store, serp, log } = deps;
  const now = deps.now ?? (() => new Date());

  const startedAt = now();
  const settings = parseSettings((await store.readMany(['Settings'])).Settings);
  const tz = settings.timezone;
  const runDate = dateInTz(startedAt, tz);
  const runId = `${runDate}-${dateTimeInTz(startedAt, tz).slice(11).replace(/:/g, '')}-${randomBytes(2).toString('hex')}`;

  await acquireLock(store, runId, startedAt);
  deps.onStarted?.(runId);
  log.info(`Прогон ${runId}: дата ${runDate} (${tz}), SERP-провайдер ${serp.name}`);

  const summary: RunSummary = {
    run_id: runId,
    run_date: runDate,
    started_at: dateTimeInTz(startedAt, tz),
    finished_at: '',
    status: 'ok',
    keywords_ok: 0,
    keywords_failed: 0,
    serp_requests: 0,
    urls_new: 0,
    urls_labeled: 0,
    fetch_failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    error: '',
  };
  const errors: string[] = [];
  const sites = new Map<string, SiteContext>();
  let labelingDegraded = false;

  try {
    const data = await store.readMany(['Keywords', 'SERP', 'Sites']);
    const allKeywords = parseKeywords(data.Keywords, (m) => log.warn(m));
    const keywords = allKeywords.filter((k) => k.active);
    log.info(`Активных ключей: ${keywords.length} из ${allKeywords.length}`);
    if (!keywords.length) throw new Error('Нет активных ключей в листе Keywords');

    // 1. Выдача по ключам. Параллельность задаёт провайдер (SearchApi — 3, бесплатный HasData — 1):
    // основное время уходит на разворот ссылок-токенов, а не на сам поиск.
    const results: { kw: Keyword; res: SerpResult }[] = [];
    let fatal: SerpError | null = null;
    const startRequests = serp.requestsTotal;
    let reportedRequests = 0;
    const queue = [...keywords];
    const searchWorker = async () => {
      for (let kw = queue.shift(); kw; kw = queue.shift()) {
        if (fatal) {
          summary.keywords_failed++;
          errors.push(`${kw.id}: пропущен — ${fatal.message}`);
          continue;
        }
        try {
          const res = await serp.search(kw.keyword);
          reportedRequests += res.requests;
          results.push({ kw, res });
          summary.keywords_ok++;
          log.info(`[${kw.id}] ${kw.keyword}: ${res.items.length} результатов, запросов ${res.requests}`);
        } catch (e) {
          summary.keywords_failed++;
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${kw.id}: ${msg}`);
          log.error(`[${kw.id}] ${kw.keyword}: ${msg}`);
          // Неверный ключ или кончилась квота: остальные ключи не тратят запросы и сразу получают failed.
          if (e instanceof SerpError && (e.kind === 'auth' || e.kind === 'quota')) fatal = e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, serp.concurrency ?? 1) }, searchWorker));
    // Счётчик провайдера учитывает и запросы по ключам, которые потом упали.
    summary.serp_requests = startRequests === undefined ? reportedRequests : (serp.requestsTotal ?? startRequests) - startRequests;
    const order = new Map(keywords.map((k, i) => [k.id, i]));
    results.sort((a, b) => order.get(a.kw.id)! - order.get(b.kw.id)!);
    errors.sort();

    // 2. SERP: upsert по (run_date, keyword_id, position) — повтор в тот же день обновляет те же строки.
    const serpRows: Row[] = [];
    for (const { kw, res } of results) {
      for (const it of res.items) {
        const normalized = normalizeUrl(it.url);
        const domain = domainOf(normalized);
        serpRows.push({
          run_date: runDate,
          keyword_id: kw.id,
          keyword: kw.keyword,
          position: it.position,
          url: it.url,
          normalized_url: normalized,
          domain,
          title: it.title,
        });
        if (!sites.has(normalized))
          sites.set(normalized, { url: it.url, normalizedUrl: normalized, domain, title: it.title, snippet: it.snippet });
      }
      // Повтор в тот же день дал меньше позиций: старые строки хвоста очищаем (ключ строки остаётся, URL стирается),
      // чтобы в истории не смешивались два снимка выдачи.
      const stale = data.SERP.filter(
        (r) => r.run_date === runDate && r.keyword_id === kw.id && Number(r.position) > res.items.length && r.normalized_url,
      );
      for (const r of stale) serpRows.push({ run_date: runDate, keyword_id: kw.id, keyword: kw.keyword, position: Number(r.position), url: '', normalized_url: '', domain: '', title: '' });
      if (stale.length) log.warn(`[${kw.id}] сегодня ${res.items.length} позиций: очищено ${stale.length} прежних строк хвоста`);
    }
    const serpUp = await store.upsert('SERP', serpRows, SHEET_KEYS.SERP);
    log.info(`SERP: добавлено ${serpUp.inserted}, обновлено ${serpUp.updated}`);

    // 3. Sites: одна строка на normalized_url.
    const siteRows = buildSiteRows(data.Sites, serpRows, runDate);
    summary.urls_new = siteRows.newCount;
    const sitesUp = await store.upsert('Sites', siteRows.rows, SHEET_KEYS.Sites);
    log.info(`Sites: новых ${sitesUp.inserted}, обновлено ${sitesUp.updated}`);

    // 4. Разметка: только URL без актуальной метки (нет метки, старше relabel_days, другая версия промпта или модель).
    if (deps.labeling) {
      const toLabel = pickSitesToLabel(data.Sites, siteRows.rows, data.SERP, sites, {
        now: startedAt,
        relabelDays: settings.relabel_days,
        promptVersion: deps.labeling.labeler.promptVersion,
        model: deps.labeling.labeler.model,
        force: deps.labeling.forceRelabel ?? false,
      });
      log.info(`Разметка: ${toLabel.length} URL без актуальной метки (модель ${deps.labeling.labeler.model}, промпт ${deps.labeling.labeler.promptVersion})`);
      if (toLabel.length) {
        const { rows, stats } = await labelSites(toLabel, {
          ...deps.labeling,
          log,
          now,
          timezone: tz,
          budgetUsd: settings.max_run_cost_usd,
        });
        await store.upsert('Sites', rows, SHEET_KEYS.Sites);
        summary.urls_labeled = stats.labeled;
        summary.fetch_failed = stats.fetchFailed;
        summary.input_tokens = stats.inputTokens;
        summary.output_tokens = stats.outputTokens;
        summary.cost_usd = Math.round(stats.costUsd * 1e6) / 1e6;
        if (stats.stoppedByBudget) errors.push(`лимит $${settings.max_run_cost_usd} достигнут, размечено ${stats.labeled} из ${toLabel.length}`);
        if (stats.llmFailed) errors.push(`llm_failed: ${stats.llmFailed} URL`);
        labelingDegraded = stats.stoppedByBudget || stats.llmFailed > 0;
        log.info(`Разметка: размечено ${stats.labeled}, не скачано ${stats.fetchFailed}, llm_failed ${stats.llmFailed}, выброшено брендов без доказательства ${stats.droppedBrands}, $${stats.costUsd.toFixed(4)}`);
      }
    }

    // 5. History целиком перестраивается из всей истории SERP.
    const kwText = new Map(allKeywords.map((k) => [k.id, k.keyword]));
    const hist = buildHistory(mergeSerp(data.SERP, serpRows), kwText);
    await store.replaceAll('History', hist.header, hist.rows);
    log.info(`History: ${hist.rows.length} строк × ${hist.header.length - 3} дат`);

    summary.status = statusOf(summary.keywords_ok, summary.keywords_failed);
    if (summary.status === 'ok' && labelingDegraded) summary.status = 'partial';
  } catch (e) {
    summary.status = 'failed';
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
    log.error(`Прогон прерван: ${msg}`);
  } finally {
    summary.finished_at = dateTimeInTz(now(), tz);
    summary.error = errors.join(' | ').slice(0, ERROR_LIMIT);
    try {
      await store.upsert('Runs', [summary as unknown as Row], SHEET_KEYS.Runs);
    } catch (e) {
      log.error(`Не удалось записать строку в Runs: ${(e as Error).message}`);
    }
    await releaseLock(store, runId).catch((e) => log.error(`Не удалось снять блокировку: ${(e as Error).message}`));
  }
  log.info(`Готово: ${summary.status}, ключей ok ${summary.keywords_ok}, failed ${summary.keywords_failed}, SERP-запросов ${summary.serp_requests}`);
  return { summary, sites };
}

export function statusOf(ok: number, failed: number): RunStatus {
  if (ok === 0) return 'failed';
  return failed > 0 ? 'partial' : 'ok';
}

/** Агрегаты по сайтам: first_seen, last_seen, best_position (минимум за всю историю), ключи. */
export function buildSiteRows(existing: ReadRow[], serpRows: Row[], runDate: string): { rows: Row[]; newCount: number } {
  const old = new Map(existing.filter((r) => r.url).map((r) => [r.url!, r]));
  const agg = new Map<string, { domain: string; best: number; kws: Set<string> }>();
  for (const r of serpRows) {
    const url = String(r.normalized_url ?? '');
    if (!url) continue; // очищенный хвост позиций — сайта нет
    const a = agg.get(url) ?? { domain: String(r.domain), best: Infinity, kws: new Set<string>() };
    a.best = Math.min(a.best, Number(r.position));
    a.kws.add(String(r.keyword_id));
    agg.set(url, a);
  }
  let newCount = 0;
  const rows: Row[] = [];
  for (const [url, a] of agg) {
    const prev = old.get(url);
    if (!prev) newCount++;
    const prevBest = Number(prev?.best_position);
    const kws = new Set([...(prev?.keywords ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...a.kws]);
    rows.push({
      url,
      domain: a.domain,
      first_seen: prev?.first_seen || runDate,
      last_seen: runDate,
      best_position: Number.isFinite(prevBest) && prevBest > 0 ? Math.min(prevBest, a.best) : a.best,
      keywords: [...kws].sort().join(', '),
    });
  }
  return { rows, newCount };
}

/**
 * Какие строки Sites размечать. Контекст (исходный URL, title, сниппет) берём из сегодняшней выдачи,
 * а для URL, которых сегодня нет, — из последней строки листа SERP (сниппета там нет).
 */
export function pickSitesToLabel(
  existing: ReadRow[],
  fresh: Row[],
  serpSheet: ReadRow[],
  today: Map<string, SiteContext>,
  opts: { now: Date; relabelDays: number; promptVersion: string; model: string; force?: boolean },
): SiteToLabel[] {
  const merged = new Map<string, ReadRow>();
  for (const r of existing) if (r.url) merged.set(r.url, r);
  for (const r of fresh) {
    const k = String(r.url);
    merged.set(k, { ...(merged.get(k) ?? {}), ...Object.fromEntries(Object.entries(r).map(([a, b]) => [a, String(b)])) });
  }
  const lastSerp = new Map<string, ReadRow>();
  for (const r of serpSheet) {
    const prev = lastSerp.get(r.normalized_url ?? '');
    if (r.normalized_url && (!prev || (r.run_date ?? '') >= (prev.run_date ?? ''))) lastSerp.set(r.normalized_url, r);
  }
  const out: (SiteToLabel & { best: number })[] = [];
  for (const [key, row] of merged) {
    if (!key) continue;
    if (!opts.force && !needsLabel(row, opts)) continue;
    const t = today.get(key);
    const old = lastSerp.get(key);
    out.push({
      key,
      fetchUrl: t?.url ?? old?.url ?? key,
      domain: row.domain || t?.domain || '',
      serpTitle: t?.title ?? old?.title ?? '',
      serpSnippet: t?.snippet ?? '',
      best: Number(row.best_position) || 99,
    });
  }
  // Самые заметные в выдаче — первыми: если упрёмся в лимит, неразмеченными останутся хвосты.
  return out.sort((a, b) => a.best - b.best).map(({ best: _b, ...site }) => site);
}
