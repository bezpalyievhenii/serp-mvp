import { Cron } from 'croner';
import type { Logger, Store } from '../../core/ports';
import { getSettings } from '../../core/settings';

/**
 * Планировщик в том же процессе, что и веб-интерфейс.
 * Перечитывает schedule_cron после изменения в интерфейсе и раз в 5 минут
 * (менеджер может поменять расписание прямо в таблице).
 */
export class Scheduler {
  private job: Cron | null = null;
  private current = '';
  private poll: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly runNow: (trigger: string) => Promise<unknown>,
    private readonly log: Logger,
  ) {}

  async start() {
    await this.reload();
    this.poll = setInterval(() => void this.reload().catch((e) => this.log.warn(`Расписание: ${(e as Error).message}`)), 5 * 60_000);
    this.poll.unref();
  }

  async reload() {
    const s = await getSettings(this.store);
    const key = `${s.schedule_cron}|${s.timezone}`;
    if (key === this.current) return;
    this.job?.stop();
    this.job = null;
    this.current = key;
    if (!s.schedule_cron) {
      this.log.info('Расписание выключено (schedule_cron пуст)');
      return;
    }
    try {
      this.job = new Cron(s.schedule_cron, { timezone: s.timezone, protect: true }, () => {
        this.log.info(`Расписание: запуск по «${s.schedule_cron}»`);
        void this.runNow('schedule').catch((e) => this.log.warn(`Плановый прогон не стартовал: ${(e as Error).message}`));
      });
      this.log.info(`Расписание: «${s.schedule_cron}» (${s.timezone}), ближайший запуск ${this.job.nextRun()?.toISOString()}`);
    } catch (e) {
      this.log.error(`Неверное расписание «${s.schedule_cron}»: ${(e as Error).message}`);
    }
  }

  nextRun(): string | null {
    return this.job?.nextRun()?.toISOString() ?? null;
  }

  stop() {
    this.job?.stop();
    if (this.poll) clearInterval(this.poll);
  }
}
