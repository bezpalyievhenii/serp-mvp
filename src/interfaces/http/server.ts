import express, { type NextFunction, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { ROOT } from '../../config';
import { KeywordError, addKeyword, listKeywords, updateKeyword } from '../../core/keywords';
import { LockBusyError, currentInProcessRun } from '../../core/lock';
import type { Labeler, Logger, PageReader, SerpProvider, Store } from '../../core/ports';
import { loadResults } from '../../core/results';
import { runPipeline } from '../../core/runPipeline';
import { SettingsError, describeCron, getSettings, setSchedule } from '../../core/settings';
import { Scheduler } from './scheduler';

export interface ServerOptions {
  store: Store;
  serp: SerpProvider;
  labeling?: { reader: PageReader; labeler: Labeler };
  log: Logger;
  port: number;
  demo: boolean;
  provider: string;
}

/** Запуск прогона: ждёт, пока прогон возьмёт блокировку, и возвращает его id. Сам прогон идёт в фоне. */
export function makeRunner(store: Store, serp: SerpProvider, log: Logger, labeling?: ServerOptions['labeling']) {
  return (trigger: string) =>
    new Promise<string>((resolveStarted, reject) => {
      if (currentInProcessRun()) return reject(new LockBusyError(`Уже идёт прогон ${currentInProcessRun()}`));
      let started = false;
      runPipeline({
        store,
        serp,
        log,
        labeling,
        onStarted: (id) => {
          started = true;
          log.info(`Прогон ${id} запущен (${trigger})`);
          resolveStarted(id);
        },
      }).catch((e) => {
        if (!started) reject(e);
        else log.error(`Прогон упал: ${(e as Error).message}`);
      });
    });
}

export async function startServer(opts: ServerOptions) {
  const { store, log } = opts;
  const runNow = makeRunner(store, opts.serp, log, opts.labeling);
  const scheduler = new Scheduler(store, runNow, log);
  await scheduler.start();

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(resolve(ROOT, 'public')));
  app.use('/i18n', express.static(resolve(ROOT, 'i18n')));

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

  app.get(
    '/api/meta',
    wrap(async (_req, res) => {
      const s = await getSettings(store);
      res.json({
        sheetUrl: store.publicUrl(),
        demo: opts.demo,
        provider: opts.provider,
        timezone: s.timezone,
        running: currentInProcessRun(),
      });
    }),
  );

  app.get(
    '/api/data',
    wrap(async (_req, res) => {
      res.json({ ...(await loadResults(store)), running: currentInProcessRun() });
    }),
  );

  app.get('/api/keywords', wrap(async (_req, res) => res.json(await listKeywords(store))));
  app.post(
    '/api/keywords',
    wrap(async (req, res) => {
      const s = await getSettings(store);
      res.status(201).json(await addKeyword(store, { keyword: String(req.body?.keyword ?? ''), cluster: String(req.body?.cluster ?? '') }, new Date(), s.timezone));
    }),
  );
  app.patch(
    '/api/keywords/:id',
    wrap(async (req, res) => {
      const b = req.body ?? {};
      res.json(
        await updateKeyword(store, String(req.params.id), {
          keyword: typeof b.keyword === 'string' ? b.keyword : undefined,
          cluster: typeof b.cluster === 'string' ? b.cluster : undefined,
          active: typeof b.active === 'boolean' ? b.active : undefined,
        }),
      );
    }),
  );

  app.post(
    '/api/runs',
    wrap(async (_req, res) => {
      try {
        res.status(202).json({ run_id: await runNow('ui') });
      } catch (e) {
        if (e instanceof LockBusyError) res.status(409).json({ error: 'run_busy', message: e.message });
        else throw e;
      }
    }),
  );

  app.get(
    '/api/schedule',
    wrap(async (_req, res) => {
      const s = await getSettings(store);
      res.json({ cron: s.schedule_cron, timezone: s.timezone, preview: describeCron(s.schedule_cron, s.timezone), nextRun: scheduler.nextRun() });
    }),
  );
  app.get(
    '/api/schedule/preview',
    wrap(async (req, res) => {
      const s = await getSettings(store);
      res.json(describeCron(String(req.query.cron ?? ''), s.timezone));
    }),
  );
  app.put(
    '/api/schedule',
    wrap(async (req, res) => {
      const s = await setSchedule(store, String(req.body?.cron ?? ''));
      await scheduler.reload();
      res.json({ cron: s.schedule_cron, timezone: s.timezone, nextRun: scheduler.nextRun() });
    }),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof KeywordError || err instanceof SettingsError) return res.status(400).json({ error: err.message });
    log.error(`API: ${(err as Error).message}`);
    res.status(500).json({ error: 'server_error', message: (err as Error).message });
  });

  const server = app.listen(opts.port, '127.0.0.1', () => {
    log.info(`Интерфейс: http://localhost:${opts.port}${opts.demo ? '  (демо-режим: данные из фикстур, таблица не меняется)' : ''}`);
  });
  return { server, scheduler };
}
