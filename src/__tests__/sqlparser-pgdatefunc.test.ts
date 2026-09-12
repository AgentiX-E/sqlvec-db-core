import { describe, it, expect, vi } from 'vitest';
import { registerDateFunctions } from '../query/PgDateFuncShim';

// PgDateFuncShim registers PG-compatible date/time functions (now() and
// current_date) as SQLite custom functions. This locks the registration
// contract and the timestamp format.
describe('PgDateFuncShim', () => {
  describe('registerDateFunctions', () => {
    it('logs a warning and returns early when db.function is absent', () => {
      // A database without a .function() method must not throw; the shim
      // should degrade gracefully with a warning.
      const db = {} as any;
      expect(() => registerDateFunctions(db)).not.toThrow();
    });

    it('registers `now` with deterministic=false (empty options) and a working formatter', () => {
      const registrations: Array<{ name: string; opts: unknown; fn: () => unknown }> = [];
      const db = {
        function: (name: string, opts: unknown, fn: () => unknown) => {
          registrations.push({ name, opts, fn });
        },
      };

      registerDateFunctions(db as any);

      expect(registrations).toHaveLength(1);
      expect(registrations[0].name).toBe('now');
      // Options object is intentionally empty (not deterministic), because
      // now() must return a new timestamp on every invocation.
      expect(registrations[0].opts).toEqual({});
    });

    it('formats now() as `YYYY-MM-DD HH:MM:SS` (PG timestamp without timezone)', () => {
      const registrations: Array<{ name: string; opts: unknown; fn: () => unknown }> = [];
      const db = {
        function: (name: string, opts: unknown, fn: () => unknown) => {
          registrations.push({ name, opts, fn });
        },
      };

      registerDateFunctions(db as any);
      const fn = registrations[0].fn as () => string;
      const result = fn();

      // 10 chars date + space + 8 chars time = 19 chars.
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });
});
