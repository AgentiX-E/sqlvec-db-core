import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectPgCron,
  rewritePgCron,
  getPgCronExecutor,
  resetPgCronExecutor,
} from '../query/PgCronShim';

// PgCronShim detects/rewrites pg_cron scheduling constructs and drives the
// PgCronExecutor. It must not treat a cron reference embedded in a string
// literal or comment as real usage (and must therefore not trigger the
// scheduling side effect).
describe('PgCronShim', () => {
  beforeEach(() => resetPgCronExecutor());
  afterEach(() => resetPgCronExecutor());

  describe('getPgCronExecutor / resetPgCronExecutor', () => {
    it('returns a singleton and resets to a fresh instance', () => {
      const a = getPgCronExecutor();
      const b = getPgCronExecutor();
      expect(a).toBe(b);
      resetPgCronExecutor();
      expect(getPgCronExecutor()).not.toBe(a);
    });
  });

  describe('detectPgCron', () => {
    it('detects cron.schedule and cron.unschedule calls', () => {
      expect(detectPgCron("SELECT cron.schedule('n','* * * * *','SELECT 1')")).toBe(true);
      expect(detectPgCron("SELECT cron.unschedule('n')")).toBe(true);
    });

    it('detects cron.job / cron.schedule table references', () => {
      expect(detectPgCron('SELECT * FROM cron.job')).toBe(true);
      expect(detectPgCron('SELECT * FROM cron.schedule')).toBe(true);
    });

    it('does not detect inside a string literal or comment', () => {
      expect(detectPgCron("SELECT 'cron.schedule(a,b,c)'")).toBe(false);
      expect(detectPgCron('-- cron.schedule(a,b,c)\nSELECT 1')).toBe(false);
      expect(detectPgCron('/* cron.job */ SELECT 1')).toBe(false);
    });

    it('returns false for unrelated SQL and non-string input', () => {
      expect(detectPgCron('SELECT 1')).toBe(false);
      expect(detectPgCron(null as any)).toBe(false);
    });
  });

  describe('rewritePgCron — schedule', () => {
    it('registers a job and returns SELECT 1 as jobid', () => {
      const r = rewritePgCron("SELECT cron.schedule('job1', '* * * * *', 'SELECT 1')");
      expect(r).toEqual({ sql: 'SELECT 1 as jobid', rewritten: true });
      expect(getPgCronExecutor().getJobs()).toEqual(['job1']);
    });

    it('does not rewrite (nor schedule) a cron.schedule inside a string literal', () => {
      const r = rewritePgCron("SELECT 'cron.schedule(a,b,c)' AS t");
      expect(r.rewritten).toBe(false);
      expect(r.sql).toBe("SELECT 'cron.schedule(a,b,c)' AS t");
      expect(getPgCronExecutor().getJobs()).toEqual([]);
    });

    it('logs a warning (not throw) when scheduling a duplicate job', () => {
      rewritePgCron("SELECT cron.schedule('dup', '* * * * *', 'SELECT 1')");
      const r = rewritePgCron("SELECT cron.schedule('dup', '* * * * *', 'SELECT 1')");
      expect(r.sql).toBe('SELECT 1 as jobid');
      expect(getPgCronExecutor().getJobs()).toEqual(['dup']);
    });

    it('rewrites but does not schedule when arguments are not string literals', () => {
      const r = rewritePgCron('SELECT cron.schedule(var1, var2, var3)');
      expect(r.sql).toBe('SELECT 1 as jobid');
      expect(getPgCronExecutor().getJobs()).toEqual([]);
    });

    it('schedules when arguments use double quotes', () => {
      const r = rewritePgCron('SELECT cron.schedule("a-job", "* * * * *", "SELECT 1")');
      expect(r.sql).toBe('SELECT 1 as jobid');
      expect(getPgCronExecutor().getJobs()).toEqual(['a-job']);
    });

    it('fires the registered callback when the cron job ticks', () => {
      rewritePgCron("SELECT cron.schedule('fire-me', '* * * * *', 'SELECT 1')");
      // Access the private job map (via any) to trigger a tick synchronously and
      // exercise the "job fired" logging callback.
      const executor = getPgCronExecutor() as any;
      const job = executor.jobs.get('fire-me');
      expect(job).toBeDefined();
      expect(() => job.fireOnTick()).not.toThrow();
      job.stop();
    });
  });

  describe('rewritePgCron — unschedule', () => {
    it('removes a job by name', () => {
      rewritePgCron("SELECT cron.schedule('job1', '* * * * *', 'SELECT 1')");
      const r = rewritePgCron("SELECT cron.unschedule('job1')");
      expect(r).toEqual({ sql: 'SELECT true', rewritten: true });
      expect(getPgCronExecutor().getJobs()).toEqual([]);
    });

    it('accepts a numeric argument without removing unmatched jobs', () => {
      rewritePgCron("SELECT cron.schedule('j1', '* * * * *', 'SELECT 1')");
      const r = rewritePgCron('SELECT cron.unschedule(999)');
      expect(r.sql).toBe('SELECT true');
      expect(getPgCronExecutor().getJobs()).toEqual(['j1']);
    });

    it('rewrites but does not unschedule when the argument is neither string nor number', () => {
      rewritePgCron("SELECT cron.schedule('j1', '* * * * *', 'SELECT 1')");
      const r = rewritePgCron('SELECT cron.unschedule(foo)');
      expect(r.sql).toBe('SELECT true');
      expect(getPgCronExecutor().getJobs()).toEqual(['j1']);
    });
  });

  describe('rewritePgCron — table query', () => {
    it('returns a static empty row when no jobs are scheduled', () => {
      const r = rewritePgCron('SELECT * FROM cron.job');
      expect(r.sql).toBe("SELECT 1 as jobid, '' as schedule, '' as command");
      expect(r.rewritten).toBe(true);
    });

    it('returns one VALUES row per scheduled job', () => {
      rewritePgCron("SELECT cron.schedule('a-job', '* * * * *', 'SELECT 1')");
      rewritePgCron("SELECT cron.schedule('b-job', '* * * * *', 'SELECT 2')");
      const r = rewritePgCron('SELECT * FROM cron.job');
      expect(r.sql).toContain("(1, 'a-job', 'scheduled')");
      expect(r.sql).toContain("(2, 'b-job', 'scheduled')");
    });

    it('handles cron.schedule as a table reference too', () => {
      const r = rewritePgCron('SELECT * FROM cron.schedule');
      expect(r.rewritten).toBe(true);
    });
  });

  describe('rewritePgCron — passthrough', () => {
    it('returns passthrough for non-string input', () => {
      expect(rewritePgCron(null as any)).toEqual({ sql: '', rewritten: false });
    });

    it('returns unchanged for non-cron SQL', () => {
      expect(rewritePgCron('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    it('detects a cron table reference but does not rewrite a non-FROM usage', () => {
      // cron.job is detected, but there is no `SELECT ... FROM cron.job` to replace.
      expect(rewritePgCron('SELECT cron.job')).toEqual({
        sql: 'SELECT cron.job', rewritten: false,
      });
    });
  });
});
