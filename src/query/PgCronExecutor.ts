import { CronJob } from 'cron';
import * as fs from 'fs';
import { PinoLogger } from '../logger/PinoLogger';

/**
 * PgCronExecutor — PostgreSQL pg_cron compatibility shim for SQLVec.
 *
 * Provides cron-based job scheduling that mimics PostgreSQL's pg_cron
 * extension. Jobs are named, scheduled with cron expressions, and can
 * be persisted to / loaded from a JSON file.
 *
 * Usage:
 *   const cron = new PgCronExecutor();
 *   cron.schedule('vacuum', '0 3 * * *', () => { ... });
 *   cron.unschedule('vacuum');
 *   cron.persist('/tmp/cron-jobs.json');
 *   cron.load('/tmp/cron-jobs.json');
 */

export interface PersistedJob {
  name: string;
  cronExpr: string;
}

export class PgCronExecutor {
  private jobs: Map<string, CronJob> = new Map();
  private cronExprs: Map<string, string> = new Map();
  private logger = PinoLogger.forComponent('pg-cron');

  /**
   * Schedule a new cron job.
   *
   * @param name     Unique job name
   * @param cronExpr Standard cron expression (e.g. "0 3 * * *")
   * @param callback Function to execute when the cron fires
   * @throws If a job with the same name already exists
   */
  schedule(name: string, cronExpr: string, callback: () => void): void {
    if (this.jobs.has(name)) {
      throw new Error(`Cron job "${name}" already exists`);
    }

    const job = new CronJob(
      cronExpr,
      () => {
        this.logger.debug({ job: name }, 'Cron job fired');
        try {
          callback();
        } catch (err) {
          this.logger.error({ err, job: name }, 'Cron job callback failed');
        }
      },
      null,         // onComplete
      false,        // start — we start manually below
      'Asia/Shanghai',
    );

    job.start();
    this.jobs.set(name, job);
    this.cronExprs.set(name, cronExpr);
    this.logger.info({ job: name, cronExpr }, 'Cron job scheduled');
  }

  /**
   * Unschedule and remove a cron job.
   *
   * @param name Name of the job to remove
   */
  unschedule(name: string): void {
    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.jobs.delete(name);
      this.cronExprs.delete(name);
      this.logger.info({ job: name }, 'Cron job unscheduled');
    }
  }

  /**
   * Get the names of all scheduled jobs.
   */
  getJobs(): string[] {
    return Array.from(this.jobs.keys());
  }

  /**
   * Persist the current job schedule to a JSON file.
   *
   * @param path File path for the persisted jobs
   */
  persist(path: string): void {
    const jobs: PersistedJob[] = [];
    for (const [name, _job] of this.jobs) {
      const cronExpr = this.cronExprs.get(name) ?? 'unknown';
      jobs.push({ name, cronExpr });
    }

    const data = JSON.stringify(jobs, null, 2);
    fs.writeFileSync(path, data, 'utf-8');
    this.logger.info({ path, count: jobs.length }, 'Cron jobs persisted');
  }

  /**
   * Load a job schedule from a JSON file.
   * Silently skips jobs that would collide with existing ones.
   *
   * @param path File path to load from
   */
  load(path: string): void {
    if (!fs.existsSync(path)) {
      this.logger.warn({ path }, 'Cron jobs file not found, skipping load');
      return;
    }

    const raw = fs.readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedJob[];

    let loaded = 0;
    for (const j of parsed) {
      if (!this.jobs.has(j.name)) {
        // Re-create a no-op CronJob so the job name is registered
        const job = new CronJob(
          j.cronExpr,
          () => {
            this.logger.warn({ job: j.name }, 'Cron job callback not restored from persisted file');
          },
          null,
          false,
          'Asia/Shanghai',
        );
        job.start();
        this.jobs.set(j.name, job);
        this.cronExprs.set(j.name, j.cronExpr);
        this.logger.warn({ job: j.name }, 'Cron job loaded from file but callback not restored');
        loaded++;
      }
    }
    this.logger.info({ path, loaded }, 'Cron jobs loaded');
  }
}
