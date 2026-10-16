import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  planAndExecute,
  shouldUsePlanner,
  shouldUseSortAggregate,
  chooseAggregateStrategy,
} from '../query/QueryPlannerIntegration';

describe('QueryPlannerIntegration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
    db.exec("INSERT INTO users VALUES (1,'alice',30),(2,'bob',25),(3,'carol',35)");
    db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL)');
    db.exec('INSERT INTO orders VALUES (1,1,10),(2,1,20),(3,2,5)');
  });

  afterEach(() => {
    db.close();
  });

  describe('planAndExecute', () => {
    it('executes a simple SELECT with an equality condition', () => {
      const r = planAndExecute('SELECT * FROM users WHERE age = 30', db);
      expect(r.rows).toEqual([{ id: 1, name: 'alice', age: 30 }]);
      expect(r.rowCount).toBe(1);
      expect(r.error).toBeUndefined();
    });

    it('executes SELECT with no table reference (SELECT 1)', () => {
      const r = planAndExecute('SELECT 1', db);
      expect(r.rows).toEqual([{ '1': 1 }]);
    });

    it('executes ORDER BY with DESC', () => {
      const r = planAndExecute('SELECT * FROM users ORDER BY age DESC', db);
      expect(r.rows.map((x: any) => x.age)).toEqual([35, 30, 25]);
    });

    it('executes an aggregate COUNT query', () => {
      const r = planAndExecute('SELECT COUNT(*) AS c FROM users', db);
      expect(r.rows).toEqual([{ c: 3 }]);
    });

    it('executes a JOIN via plan executor', () => {
      const r = planAndExecute(
        'SELECT * FROM users u JOIN orders o ON u.id = o.user_id',
        db,
      );
      expect(r.rowCount).toBe(3);
    });

    it('falls back for non-SELECT (INSERT)', () => {
      const r = planAndExecute(
        "INSERT INTO users VALUES (4,'dave',40)",
        db,
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 4 });
    });

    it('falls back for UPDATE', () => {
      const r = planAndExecute("UPDATE users SET age = 31 WHERE id = 1", db);
      expect(r.rowCount).toBe(1);
    });

    it('falls back for DELETE', () => {
      const r = planAndExecute('DELETE FROM users WHERE id = 3', db);
      expect(r.rowCount).toBe(1);
    });

    it('falls back for DDL (CREATE TABLE)', () => {
      const r = planAndExecute('CREATE TABLE foo (id INTEGER)', db);
      expect(r.error).toBeUndefined();
    });

    it('falls back when a correlatable subquery is present', () => {
      const r = planAndExecute(
        'SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE orders.amount > 10)',
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('falls back when IN (list) is present', () => {
      const r = planAndExecute(
        'SELECT * FROM users WHERE id IN (1, 2)',
        db,
      );
      expect(r.rowCount).toBe(2);
    });

    it('applies LIMIT by slicing rows', () => {
      const r = planAndExecute('SELECT * FROM users ORDER BY age DESC LIMIT 2', db);
      expect(r.rows.map((x: any) => x.age)).toEqual([35, 30]);
    });

    it('returns an error result when the table does not exist', () => {
      const r = planAndExecute('SELECT * FROM nonexistent_table', db);
      expect(r.error).toBeDefined();
      expect(r.rowCount).toBe(0);
    });

    it('executes with a != condition', () => {
      const r = planAndExecute('SELECT * FROM users WHERE age != 30', db);
      expect(r.rowCount).toBe(2);
    });

    it('executes with a <> condition', () => {
      const r = planAndExecute('SELECT * FROM users WHERE id <> 1', db);
      expect(r.rowCount).toBe(2);
    });

    it('executes with a range condition (<)', () => {
      const r = planAndExecute('SELECT * FROM users WHERE age < 30', db);
      expect(r.rows.map((x: any) => x.age)).toEqual([25]);
    });

    it('executes with a range condition (>=)', () => {
      const r = planAndExecute('SELECT * FROM users WHERE age >= 30', db);
      expect(r.rows.map((x: any) => x.age)).toEqual([30, 35]);
    });

    it('executes with a LIKE condition', () => {
      const r = planAndExecute("SELECT * FROM users WHERE name LIKE 'a%'", db);
      expect(r.rows.map((x: any) => x.name)).toEqual(['alice']);
    });

    it('executes with an IS NULL condition', () => {
      db.exec("INSERT INTO users (id, name, age) VALUES (9, NULL, NULL)");
      const r = planAndExecute('SELECT * FROM users WHERE age IS NULL', db);
      expect(r.rows.map((x: any) => x.id)).toEqual([9]);
    });

    it('executes with an IS NOT NULL condition', () => {
      db.exec("INSERT INTO users (id, name, age) VALUES (9, NULL, NULL)");
      const r = planAndExecute('SELECT * FROM users WHERE age IS NOT NULL', db);
      expect(r.rowCount).toBe(3);
    });

    it('executes with an AND combined condition', () => {
      const r = planAndExecute(
        'SELECT * FROM users WHERE age > 25 AND age < 35',
        db,
      );
      expect(r.rows.map((x: any) => x.age)).toEqual([30]);
    });

    it('executes with an OR combined condition', () => {
      const r = planAndExecute(
        'SELECT * FROM users WHERE age = 25 OR age = 35',
        db,
      );
      expect(r.rowCount).toBe(2);
    });

    it('executes with nested parentheses in WHERE', () => {
      const r = planAndExecute(
        'SELECT * FROM users WHERE (age > 25 AND age < 40)',
        db,
      );
      expect(r.rowCount).toBe(2);
    });

    it('executes aggregate with GROUP BY', () => {
      const r = planAndExecute(
        'SELECT COUNT(*) AS c FROM users GROUP BY age',
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('executes SELECT with RETURNING-style fallback (falls back)', () => {
      const r = planAndExecute('SELECT * FROM users WHERE age = 30', db, []);
      expect(r.rowCount).toBe(1);
    });

    it('passes params through to fallback path', () => {
      const r = planAndExecute('SELECT * FROM users WHERE age = ?', db, [25]);
      expect(r.rows.map((x: any) => x.age)).toEqual([25]);
    });

    it('skips a column literally named exists', () => {
      const r = planAndExecute('SELECT * FROM users WHERE exists = 1', db);
      expect(r.error).toBeUndefined();
    });

    it('executes aggregate with DISTINCT (extractAggregateInfo no-match)', () => {
      const r = planAndExecute('SELECT COUNT(DISTINCT age) AS d FROM users', db);
      expect(r.error).toBeUndefined();
    });

    it('executes equality + aggregate', () => {
      const r = planAndExecute('SELECT COUNT(*) AS c FROM users WHERE age = 30', db);
      expect(r.error).toBeUndefined();
    });

    it('executes equality + ORDER BY (asc)', () => {
      const r = planAndExecute('SELECT * FROM users WHERE age = 30 ORDER BY age', db);
      expect(r.error).toBeUndefined();
    });

    it('executes unconditional ORDER BY (asc)', () => {
      const r = planAndExecute('SELECT * FROM users ORDER BY age', db);
      expect(r.rows.map((x: any) => x.age)).toEqual([25, 30, 35]);
    });

    it('executes JOIN with ORDER BY', () => {
      const r = planAndExecute(
        'SELECT * FROM users u JOIN orders o ON u.id = o.user_id ORDER BY u.id',
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('falls back for INSERT with RETURNING', () => {
      const r = planAndExecute(
        "INSERT INTO users (id, name, age) VALUES (5, 'eve', 22) RETURNING id",
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('executes equality + ORDER BY DESC', () => {
      const r = planAndExecute(
        'SELECT * FROM users WHERE age = 30 ORDER BY age DESC',
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('executes range condition + aggregate', () => {
      const r = planAndExecute('SELECT COUNT(*) AS c FROM users WHERE age != 30', db);
      expect(r.error).toBeUndefined();
    });

    it('executes range condition + ORDER BY', () => {
      const r = planAndExecute('SELECT * FROM users WHERE age > 25 ORDER BY age', db);
      expect(r.rows.map((x: any) => x.age)).toEqual([30, 35]);
    });

    it('executes JOIN with ORDER BY DESC', () => {
      const r = planAndExecute(
        'SELECT * FROM users u JOIN orders o ON u.id = o.user_id ORDER BY u.id DESC',
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('executes aggregate without AS alias', () => {
      const r = planAndExecute('SELECT COUNT(*) FROM users', db);
      expect(r.error).toBeUndefined();
    });

    it('executes repeated table reference via self-join', () => {
      const r = planAndExecute(
        'SELECT * FROM users a JOIN users b ON a.id = b.id',
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('executes a range LIKE condition with ORDER BY', () => {
      const r = planAndExecute("SELECT * FROM users WHERE name LIKE '%' ORDER BY name", db);
      expect(r.error).toBeUndefined();
    });

    it('executes range condition + ORDER BY DESC', () => {
      const r = planAndExecute(
        'SELECT * FROM users WHERE age > 25 ORDER BY age DESC',
        db,
      );
      expect(r.rows.map((x: any) => x.age)).toEqual([35, 30]);
    });

    it('executes JOIN with unqualified ORDER BY DESC', () => {
      const r = planAndExecute(
        'SELECT * FROM users u JOIN orders o ON u.id = o.user_id ORDER BY amount DESC',
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('applies LIMIT on a non-sort plan', () => {
      const r = planAndExecute('SELECT * FROM users LIMIT 1', db);
      expect(r.rowCount).toBe(1);
    });

    it('falls back for non-SELECT with binding params', () => {
      const r = planAndExecute(
        "UPDATE users SET age = ? WHERE id = ?",
        db,
        [99, 1],
      );
      expect(r.error).toBeUndefined();
    });

    it('handles an unterminated parenthesis in WHERE (falls back)', () => {
      const r = planAndExecute('SELECT * FROM users WHERE (age > 25', db);
      expect(r.error).toBeUndefined();
    });

    it('handles deeply nested parentheses in WHERE', () => {
      const r = planAndExecute(
        'SELECT * FROM users WHERE ((age > 25 AND age < 40))',
        db,
      );
      expect(r.error).toBeUndefined();
    });

    it('falls back for DDL (DROP TABLE) with null changes', () => {
      const r = planAndExecute('DROP TABLE IF EXISTS phantom', db);
      expect(r.error).toBeUndefined();
    });
  });

  describe('shouldUsePlanner', () => {
    it('returns false for non-SELECT', () => {
      expect(shouldUsePlanner('INSERT INTO t VALUES (1)')).toBe(false);
    });

    it('returns true for multi-table JOIN', () => {
      expect(shouldUsePlanner('SELECT * FROM a JOIN b ON a.id = b.id')).toBe(true);
    });

    it('returns true for aggregate query', () => {
      expect(shouldUsePlanner('SELECT COUNT(*) FROM users')).toBe(true);
      expect(shouldUsePlanner('SELECT SUM(age) FROM users')).toBe(true);
      expect(shouldUsePlanner('SELECT AVG(age) FROM users')).toBe(true);
      expect(shouldUsePlanner('SELECT MIN(age) FROM users')).toBe(true);
      expect(shouldUsePlanner('SELECT MAX(age) FROM users')).toBe(true);
    });

    it('returns true for ORDER BY', () => {
      expect(shouldUsePlanner('SELECT * FROM users ORDER BY age')).toBe(true);
    });

    it('returns false for a simple SELECT', () => {
      expect(shouldUsePlanner('SELECT * FROM users')).toBe(false);
    });
  });

  describe('shouldUseSortAggregate', () => {
    it('returns true for strong positive correlation', () => {
      expect(shouldUseSortAggregate(0.8)).toBe(true);
    });

    it('returns true for strong negative correlation', () => {
      expect(shouldUseSortAggregate(-0.9)).toBe(true);
    });

    it('returns false for weak correlation', () => {
      expect(shouldUseSortAggregate(0.3)).toBe(false);
    });

    it('returns false for exactly 0.5', () => {
      expect(shouldUseSortAggregate(0.5)).toBe(false);
    });
  });

  describe('chooseAggregateStrategy', () => {
    const aggPlan = {
      type: 'aggregate' as const,
      startupCost: 0,
      totalCost: 10,
      rows: 1,
      width: 0,
      description: 'Aggregate (fn=count, column=*, group=age, alias=c)',
    };

    it('returns the plan unchanged for non-aggregate plans', () => {
      const sortPlan = {
        type: 'sort' as const,
        startupCost: 0,
        totalCost: 8,
        rows: 1,
        width: 0,
        description: 'Sort (key=age, order=DESC)',
      };
      expect(chooseAggregateStrategy(sortPlan, 0.9)).toBe(sortPlan);
    });

    it('converts to SortAggregate when correlation is strong', () => {
      const r = chooseAggregateStrategy(aggPlan, 0.9);
      expect(r.type).toBe('aggregate');
      expect(r.description).toContain('SortAggregate');
    });

    it('keeps Aggregate when correlation is weak', () => {
      const r = chooseAggregateStrategy(aggPlan, 0.3);
      expect(r.description).toContain('Aggregate (fn=count');
      expect(r.description).not.toContain('SortAggregate');
    });

    it('keeps Aggregate when description has no group= clause', () => {
      const noGroup = { ...aggPlan, description: 'Aggregate (fn=count, column=*, alias=c)' };
      const r = chooseAggregateStrategy(noGroup, 0.9);
      expect(r.description).toBe('Aggregate (fn=count, column=*, alias=c)');
    });
  });
});
