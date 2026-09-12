import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PgCronExecutor } from '../query/PgCronExecutor';

// PgCronExecutor wraps node-cron's CronJob with SQLVec's pg_cron-compatible
// semantics: named jobs, a cron expression per job, and JSON persistence.
describe('PgCronExecutor', () => {
  let tmp: string;
  let executor: PgCronExecutor;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgcron-'));
    executor = new PgCronExecutor();
  });

  afterEach(() => {
    // Stop any still-running jobs so node-cron timers do not keep the process alive.
    for (const name of executor.getJobs()) {
      executor.unschedule(name);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('schedule', () => {
    it('registers a named job and reports it via getJobs', () => {
      executor.schedule('vacuum', '0 3 * * *', () => {});
      expect(executor.getJobs()).toEqual(['vacuum']);
    });

    it('throws when scheduling a duplicate name', () => {
      executor.schedule('dup', '0 3 * * *', () => {});
      expect(() => executor.schedule('dup', '0 3 * * *', () => {}))
        .toThrow('Cron job "dup" already exists');
    });

    it('throws for an invalid cron expression (delegated to node-cron)', () => {
      expect(() => executor.schedule('bad', 'not a cron', () => {}))
        .toThrow();
    });

    it('invokes the callback when the job fires', () => {
      let fired = 0;
      executor.schedule('cb', '* * * * *', () => { fired += 1; });
      const job = (executor as any).jobs.get('cb');
      job.fireOnTick();
      expect(fired).toBe(1);
      job.stop();
    });

    it('logs (does not throw) when the callback itself throws', () => {
      executor.schedule('cb', '* * * * *', () => { throw new Error('boom'); });
      const job = (executor as any).jobs.get('cb');
      expect(() => job.fireOnTick()).not.toThrow();
      job.stop();
    });
  });

  describe('unschedule', () => {
    it('removes an existing job', () => {
      executor.schedule('a', '0 3 * * *', () => {});
      executor.unschedule('a');
      expect(executor.getJobs()).toEqual([]);
    });

    it('is a no-op for an unknown job name', () => {
      executor.schedule('a', '0 3 * * *', () => {});
      executor.unschedule('missing');
      expect(executor.getJobs()).toEqual(['a']);
    });
  });

  describe('persist', () => {
    it('writes an empty JSON array when no jobs exist', () => {
      const p = path.join(tmp, 'empty.json');
      executor.persist(p);
      expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual([]);
    });

    it('writes name + cronExpr for every scheduled job', () => {
      executor.schedule('a', '0 3 * * *', () => {});
      executor.schedule('b', '*/5 * * * *', () => {});
      const p = path.join(tmp, 'jobs.json');
      executor.persist(p);
      expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual([
        { name: 'a', cronExpr: '0 3 * * *' },
        { name: 'b', cronExpr: '*/5 * * * *' },
      ]);
    });
  });

  describe('load', () => {
    it('logs a warning and skips when the file does not exist', () => {
      executor.load(path.join(tmp, 'missing.json'));
      expect(executor.getJobs()).toEqual([]);
    });

    it('loads jobs from a valid JSON file', () => {
      const p = path.join(tmp, 'jobs.json');
      fs.writeFileSync(p, JSON.stringify([{ name: 'a', cronExpr: '0 3 * * *' }]));
      executor.load(p);
      expect(executor.getJobs()).toEqual(['a']);
    });

    it('throws on malformed JSON', () => {
      const p = path.join(tmp, 'bad.json');
      fs.writeFileSync(p, 'not json{');
      expect(() => executor.load(p)).toThrow();
    });

    it('silently skips jobs that collide with existing ones', () => {
      executor.schedule('a', '0 3 * * *', () => {});
      const p = path.join(tmp, 'jobs.json');
      fs.writeFileSync(p, JSON.stringify([
        { name: 'a', cronExpr: '0 3 * * *' },
        { name: 'b', cronExpr: '*/5 * * * *' },
      ]));
      executor.load(p);
      expect(executor.getJobs()).toEqual(['a', 'b']);
    });

    it('registers a colliding-name job only once', () => {
      const p = path.join(tmp, 'dup.json');
      fs.writeFileSync(p, JSON.stringify([
        { name: 'a', cronExpr: '0 3 * * *' },
        { name: 'a', cronExpr: '*/5 * * * *' },
      ]));
      executor.load(p);
      expect(executor.getJobs()).toEqual(['a']);
    });

    it('fires the restored no-op callback when a loaded job ticks', () => {
      const p = path.join(tmp, 'jobs.json');
      fs.writeFileSync(p, JSON.stringify([{ name: 'a', cronExpr: '* * * * *' }]));
      executor.load(p);
      const job = (executor as any).jobs.get('a');
      expect(() => job.fireOnTick()).not.toThrow();
      job.stop();
    });

    it('falls back to "unknown" when a job name is missing its cron expression', () => {
      executor.schedule('a', '0 3 * * *', () => {});
      // Simulate a desync between jobs and cronExprs to exercise the ?? fallback.
      (executor as any).cronExprs.delete('a');
      const p = path.join(tmp, 'jobs.json');
      executor.persist(p);
      expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual([
        { name: 'a', cronExpr: 'unknown' },
      ]);
    });
  });
});
