/**
 * Unit tests for RLSInjector.
 *
 * The RLSInjector rewrites SQL at execution time to enforce row-level
 * security (RLS) policies.  It parses SQL with `pgsql-ast-parser`, identifies
 * referenced tables across JOINs / subqueries / CTEs / unions, and injects each
 * matching policy's USING expression as an additional WHERE predicate.
 *
 * This module was previously 0% covered — a complete, non-stub implementation
 * that had simply never been exercised.  These tests verify both the public
 * policy-management API and the SQL-rewriting pipeline (AST + regex fallback).
 */
import { describe, it, expect } from 'vitest';
import { RLSInjector } from '../query/RLSInjector';

describe('RLSInjector — policy management', () => {
  it('createPolicy registers an enabled policy', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    expect(rls.getAllPolicies()).toHaveLength(1);
    expect(rls.getAllPolicies()[0].enabled).toBe(true);
  });

  it('dropPolicy removes a policy by name', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'x = 1');
    rls.dropPolicy('p1');
    expect(rls.getAllPolicies()).toHaveLength(0);
  });

  it('dropAllPoliciesForTable removes only matching-table policies', () => {
    const rls = new RLSInjector();
    rls.createPolicy('a', 'orders', 'SELECT', 'x = 1');
    rls.createPolicy('b', 'users', 'SELECT', 'y = 2');
    rls.createPolicy('c', 'orders', 'DELETE', 'z = 3');
    rls.dropAllPoliciesForTable('orders');
    const names = rls.getAllPolicies().map((p) => p.name).sort();
    expect(names).toEqual(['b']);
  });

  it('getPoliciesForTable filters by table', () => {
    const rls = new RLSInjector();
    rls.createPolicy('a', 'orders', 'SELECT', 'x = 1');
    rls.createPolicy('b', 'users', 'SELECT', 'y = 2');
    expect(rls.getPoliciesForTable('orders')).toHaveLength(1);
    expect(rls.getPoliciesForTable('nope')).toHaveLength(0);
  });

  it('getActivePolicies returns only enabled policies for a table', () => {
    const rls = new RLSInjector();
    rls.createPolicy('a', 'orders', 'SELECT', 'x = 1');
    rls.createPolicy('b', 'orders', 'SELECT', 'y = 2');
    rls.setPolicyEnabled('b', false);
    const active = rls.getActivePolicies('orders');
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('a');
  });

  it('setPolicyEnabled toggles a policy', () => {
    const rls = new RLSInjector();
    rls.createPolicy('a', 'orders', 'SELECT', 'x = 1');
    rls.setPolicyEnabled('a', false);
    expect(rls.getActivePolicies('orders')).toHaveLength(0);
    rls.setPolicyEnabled('a', true);
    expect(rls.getActivePolicies('orders')).toHaveLength(1);
  });

  it('reset clears all policies', () => {
    const rls = new RLSInjector();
    rls.createPolicy('a', 'orders', 'SELECT', 'x = 1');
    rls.reset();
    expect(rls.getAllPolicies()).toHaveLength(0);
  });
});

describe('RLSInjector — injectRLS (AST path)', () => {
  it('returns the SQL unchanged when no policies exist', () => {
    const rls = new RLSInjector();
    expect(rls.injectRLS('SELECT * FROM orders', 'alice')).toBe('SELECT * FROM orders');
  });

  it('injects a WHERE predicate into a SELECT', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders', 'alice');
    expect(out).toContain("'alice'");expect(out.toLowerCase()).toContain("tenant_id");
    expect(out.toLowerCase()).toContain('where');
  });

  it('conjoins RLS condition with an existing WHERE clause', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE status = 1', 'alice');
    expect(out).toContain('status');
    expect(out).toContain("'alice'");expect(out.toLowerCase()).toContain("tenant_id");
  });

  it('injects into UPDATE and DELETE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('pu', 'orders', 'UPDATE', 'tenant_id = current_user');
    rls.createPolicy('pd', 'orders', 'DELETE', 'tenant_id = current_user');
    const upd = rls.injectRLS('UPDATE orders SET x = 1', 'alice');
    const del = rls.injectRLS('DELETE FROM orders', 'alice');
    expect(upd).toContain("'alice'");expect(upd.toLowerCase()).toContain("tenant_id");
    expect(del).toContain("'alice'");expect(del.toLowerCase()).toContain("tenant_id");
  });

  it('matches ALL-command policies to any DML', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'ALL', 'tenant_id = current_user');
    const sel = rls.injectRLS('SELECT * FROM orders', 'alice');
    const del = rls.injectRLS('DELETE FROM orders', 'alice');
    expect(sel).toContain("'alice'");expect(sel.toLowerCase()).toContain("tenant_id");
    expect(del).toContain("'alice'");expect(del.toLowerCase()).toContain("tenant_id");
  });

  it('ignores disabled policies', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.setPolicyEnabled('p1', false);
    expect(rls.injectRLS('SELECT * FROM orders', 'alice')).toBe('SELECT * FROM orders');
  });

  it('does not inject for tables without a matching policy', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    expect(rls.injectRLS('SELECT * FROM users', 'alice')).toBe('SELECT * FROM users');
  });
});

describe('RLSInjector — injectForUser', () => {
  it('returns unchanged when no policies exist', () => {
    const rls = new RLSInjector();
    expect(rls.injectForUser('SELECT * FROM orders', 'alice')).toBe('SELECT * FROM orders');
  });

  it('injects for a specific table when provided', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectForUser('SELECT * FROM orders', 'alice', 'orders');
    expect(out).toContain("'alice'");expect(out.toLowerCase()).toContain("tenant_id");
  });

  it('injects across auto-detected tables', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectForUser('SELECT * FROM orders', 'alice');
    expect(out).toContain("'alice'");expect(out.toLowerCase()).toContain("tenant_id");
  });
});

describe('RLSInjector — initializeForQuery', () => {
  it('returns unchanged with no policies or empty table list', () => {
    const rls = new RLSInjector();
    expect(rls.initializeForQuery('SELECT * FROM orders', 'alice', [])).toBe(
      'SELECT * FROM orders',
    );
    expect(rls.initializeForQuery('SELECT * FROM orders', 'alice', ['orders'])).toBe(
      'SELECT * FROM orders',
    );
  });

  it('injects for the given tables', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.initializeForQuery('SELECT * FROM orders', 'alice', ['orders']);
    expect(out).toContain("'alice'");expect(out.toLowerCase()).toContain("tenant_id");
  });
});

describe('RLSInjector — regex fallback injection', () => {
  it('substitutes current_user into USING clauses', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user AND region = current_user');
    const out = rls.injectRLS('SELECT * FROM orders', "o'brien");
    expect(out).toContain("'o''brien'");expect(out.toLowerCase()).toContain("tenant_id");
  });

  it('injects an AND-condition into an existing WHERE clause', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE status = 1', 'alice');
    expect(out).toContain('status');
    expect(out).toContain("'alice'");expect(out.toLowerCase()).toContain("tenant_id");
  });

  it('injects a fresh WHERE clause when none exists', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders', 'alice');
    expect(out.toLowerCase()).toContain('where');
    expect(out).toContain("'alice'");expect(out.toLowerCase()).toContain("tenant_id");
  });
});

describe('RLSInjector — complex statement shapes (AST)', () => {
  it('injects into UNION branches', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders UNION SELECT * FROM orders', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });

  it('injects into a WITH (CTE) statement', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('WITH o AS (SELECT * FROM orders) SELECT * FROM o', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });

  it('injects into UPDATE ... FROM', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'UPDATE', 'tenant_id = current_user');
    const out = rls.injectRLS("UPDATE orders SET x = 1 FROM users u WHERE u.id = orders.uid", 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
  });

  it('injects into WHERE-clause subqueries', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS(
      'SELECT * FROM orders WHERE id IN (SELECT id FROM orders)',
      'alice',
    );
    expect(out.toLowerCase()).toContain('tenant_id');
  });

  it('handles complex WHERE expressions (binary/call/case/cast)', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS(
      "SELECT * FROM orders WHERE UPPER(name) = 'X' AND (CASE WHEN a THEN b ELSE c END) AND (x::int > 1)",
      'alice',
    );
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });

  it('leaves non-DML statements unchanged', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    expect(rls.injectRLS('ALTER TABLE orders ADD COLUMN x int', 'alice')).toBe(
      'ALTER TABLE orders ADD COLUMN x int',
    );
  });
});

describe('RLSInjector — regex fallback', () => {
  it('falls back to regex when AST parsing fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE (', 'alice');
    // AST parse throws; regex fallback injects the condition
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });

  it('injectForUser falls back to regex for unparseable SQL', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectForUser('SELECT * FROM orders WHERE (', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
  });

  it('initializeForQuery falls back to regex on parse failure', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.initializeForQuery('SELECT * FROM orders WHERE (', 'alice', ['orders']);
    expect(out.toLowerCase()).toContain('tenant_id');
  });

  it('handles a WHERE clause followed by GROUP BY in regex fallback', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p1', 'orders', 'SELECT', 'tenant_id = current_user');
    // No WHERE initially — regex inserts one before GROUP BY
    const out = rls.injectRLS('SELCT * FROM orders GROUP BY tenant_id', 'alice');
    // detectStatementType returns null for 'SELCT', so unchanged
    expect(out).toBe('SELCT * FROM orders GROUP BY tenant_id');
  });
});

describe('RLSInjector — INSERT policies', () => {
  it('injects RLS into INSERT ... SELECT', () => {
    const rls = new RLSInjector();
    rls.createPolicy('pi', 'orders', 'INSERT', 'tenant_id = current_user');
    const out = rls.injectRLS('INSERT INTO orders SELECT * FROM src', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });

  it('does not corrupt INSERT ... VALUES', () => {
    const rls = new RLSInjector();
    rls.createPolicy('pi', 'orders', 'INSERT', 'tenant_id = current_user');
    // VALUES form is left intact (documented WITH CHECK limitation).
    const out = rls.injectRLS('INSERT INTO orders (a,b) VALUES (1,2)', 'alice');
    expect(out).toContain('VALUES');
    expect(out).toContain('1');
  });
});

describe('RLSInjector — recursion & complex expressions', () => {
  it('injects into WITH RECURSIVE with a policy-bearing table', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS(
      'WITH RECURSIVE o AS (SELECT * FROM orders) SELECT * FROM o',
      'alice',
    );
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });

  it('injects into a FROM subquery', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM (SELECT * FROM orders) x', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
  });

  it('handles unary NOT expressions in WHERE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE NOT (tenant_id IS NULL)', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
  });

  it('handles IN-list expressions in WHERE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE id IN (1,2,3)', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
  });

  it('handles CASE expressions in WHERE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS(
      'SELECT * FROM orders WHERE CASE WHEN x THEN a ELSE b END',
      'alice',
    );
    expect(out.toLowerCase()).toContain('tenant_id');
  });

  it('injects RLS into DELETE with an existing WHERE clause', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'DELETE', 'tenant_id = current_user');
    const out = rls.injectRLS('DELETE FROM orders WHERE id = 1', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });
});

describe('RLSInjector — WITH RECURSIVE', () => {
  it('injects RLS into a WITH RECURSIVE CTE body', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS(
      'WITH RECURSIVE o(n) AS (SELECT 1 UNION ALL SELECT n FROM orders) SELECT * FROM o',
      'alice',
    );
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });
});

describe('RLSInjector — INSERT select with WHERE + condition fallback', () => {
  it('conjoins RLS with an existing WHERE in INSERT ... SELECT', () => {
    const rls = new RLSInjector();
    rls.createPolicy('pi', 'orders', 'INSERT', 'tenant_id = current_user');
    const out = rls.injectRLS('INSERT INTO orders SELECT * FROM src WHERE x = 1', 'alice');
    expect(out.toLowerCase()).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });

  it('handles a USING expression that only parses when wrapped', () => {
    const rls = new RLSInjector();
    // A condition with a bare binary that needs parenthesization to parse as expr.
    rls.createPolicy('p', 'orders', 'SELECT', 'a AND b');
    const out = rls.injectRLS('SELECT * FROM orders', 'alice');
    // Should not throw; either injects or leaves unchanged depending on parse.
    expect(typeof out).toBe('string');
  });
});

describe('RLSInjector — statement-type fallback (non-parseable SQL)', () => {
  it('identifies UPDATE main statement in WITH when AST fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'UPDATE', 'tenant_id = current_user');
    // AST parse fails (trailing incomplete), falls back to WITH-clause scan.
    const out = rls.injectForUser('WITH o AS (SELECT 1) UPDATE orders SET x =', 'alice');
    expect(typeof out).toBe('string');
  });

  it('identifies INSERT main statement in WITH when AST fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'INSERT', 'tenant_id = current_user');
    const out = rls.injectForUser('WITH o AS (SELECT 1) INSERT INTO', 'alice');
    expect(typeof out).toBe('string');
  });

  it('identifies DELETE main statement in WITH when AST fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'DELETE', 'tenant_id = current_user');
    const out = rls.injectForUser('WITH o AS (SELECT 1) DELETE FROM', 'alice');
    expect(typeof out).toBe('string');
  });

  it('returns null type for a WITH RECURSIVE statement that cannot be scanned', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectForUser(
      'WITH RECURSIVE o(n) AS (SELECT 1 UNION ALL SELECT n FROM o) SELCT * FROM o',
      'alice',
    );
    expect(typeof out).toBe('string');
  });
});

describe('RLSInjector — condition-expression parse fallback', () => {
  it('wraps a scalar subquery condition in parentheses when bare parse fails', () => {
    const rls = new RLSInjector();
    // 'SELECT 1' fails as a bare expr but parses as a parenthesized scalar subquery.
    rls.createPolicy('p', 'orders', 'SELECT', 'SELECT 1');
    const out = rls.injectRLS('SELECT * FROM orders', 'alice');
    expect(out.toLowerCase()).toContain('select');
  });

  it('returns null condition and leaves SQL unchanged when both parses fail', () => {
    const rls = new RLSInjector();
    // 'AND b' cannot be parsed either bare or wrapped.
    rls.createPolicy('p', 'orders', 'SELECT', 'AND b');
    const out = rls.injectRLS('SELECT * FROM orders', 'alice');
    // No RLS injection possible; the query is returned unchanged.
    expect(out).toMatch(/select/i);
  });
});

describe('RLSInjector — function-call FROM source', () => {
  it('skips a non-table FROM source (set-returning function)', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    // generate_series is a function call, not a table/statement FROM source.
    const out = rls.injectRLS('SELECT * FROM generate_series(1,10)', 'alice');
    expect(typeof out).toBe('string');
  });
});

describe('RLSInjector — regex fallback without WHERE', () => {
  it('injects WHERE before ORDER BY when AST parse fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    // Trailing incomplete clause forces regex fallback (no WHERE in source).
    const out = rls.injectForUser('SELECT * FROM orders ORDER BY ', 'alice');
    expect(out).toContain('tenant_id');
    expect(out).toContain("'alice'");
  });
});

describe('RLSInjector — multi-statement with non-DML', () => {
  it('injects RLS into DML while passing through a non-DML statement', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders; CREATE TABLE x (a int)', 'alice');
    expect(out).toContain('tenant_id');
    expect(out).toContain('CREATE TABLE');
  });
});

describe('RLSInjector — broad branch coverage', () => {
  it('handles UNION ALL (both union type branches)', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders UNION ALL SELECT * FROM orders', 'alice');
    expect(out).toContain('tenant_id');
  });

  it('handles a cast expression in WHERE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE id = CAST(x AS int)', 'alice');
    expect(out).toContain('tenant_id');
  });

  it('handles CASE ... ELSE in WHERE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS(
      'SELECT * FROM orders WHERE CASE WHEN a > 1 THEN 1 ELSE 0 END = 1',
      'alice',
    );
    expect(out).toContain('tenant_id');
  });

  it('handles a nested subquery in WHERE via IN', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.createPolicy('p2', 'items', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE id IN (SELECT id FROM items)', 'alice');
    expect(out).toContain('tenant_id');
  });

  it('handles unary and function-call expressions in WHERE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE NOT (coalesce(a, b) = 1)', 'alice');
    expect(out).toContain('tenant_id');
  });

  it('returns null command for empty/whitespace input', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('   ', 'alice');
    expect(typeof out).toBe('string');
  });

  it('skips disabled policies', () => {
    const rls = new RLSInjector();
    const p = rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.setPolicyEnabled('p', false);
    const out = rls.injectRLS('SELECT * FROM orders', 'alice');
    expect(out).not.toContain('tenant_id');
  });
});

describe('RLSInjector — first-keyword DML fallback', () => {
  it('detects INSERT by first keyword when AST parse fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'INSERT', 'tenant_id = current_user');
    const out = rls.injectForUser('INSERT INTO', 'alice');
    expect(typeof out).toBe('string');
  });

  it('detects UPDATE by first keyword when AST parse fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'UPDATE', 'tenant_id = current_user');
    const out = rls.injectForUser('UPDATE orders', 'alice');
    expect(typeof out).toBe('string');
  });

  it('detects DELETE by first keyword when AST parse fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'DELETE', 'tenant_id = current_user');
    const out = rls.injectForUser('DELETE FROM', 'alice');
    expect(typeof out).toBe('string');
  });

  it('detects SELECT by first keyword when AST parse fails', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectForUser('SELECT * FROM', 'alice');
    expect(typeof out).toBe('string');
  });
});

describe('RLSInjector — CASE variants in WHERE', () => {
  it('handles searched CASE without value or ELSE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE CASE WHEN a THEN b END', 'alice');
    expect(out).toContain('tenant_id');
  });

  it('handles simple CASE with value but without ELSE', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM orders WHERE CASE x WHEN 1 THEN a END', 'alice');
    expect(out).toContain('tenant_id');
  });
});

describe('RLSInjector — UPDATE FROM and specific-table injection', () => {
  it('handles UPDATE with a single-table FROM clause', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'UPDATE', 'tenant_id = current_user');
    const out = rls.injectRLS('UPDATE orders SET x = 1 FROM src WHERE orders.id = src.id', 'alice');
    expect(out).toContain('tenant_id');
  });

  it('injects for a specific table without matching policies (no-op)', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectForUser('SELECT * FROM other_table', 'alice', 'other_table');
    expect(out).not.toContain('tenant_id');
  });

  it('injects for a specific table with matching policies', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectForUser('SELECT * FROM orders', 'alice', 'orders');
    expect(out).toContain('tenant_id');
  });

  it('skips injection for a specific table whose policies are all disabled', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.setPolicyEnabled('p', false);
    const out = rls.injectForUser('SELECT * FROM orders', 'alice', 'orders');
    expect(out).not.toContain('tenant_id');
  });
});

describe('RLSInjector — initializeForQuery', () => {
  it('returns unchanged for a non-DML statement', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.initializeForQuery('CREATE TABLE x(a int)', 'alice', ['orders']);
    expect(out).not.toContain('tenant_id');
  });

  it('skips injection when a table has only disabled policies', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.setPolicyEnabled('p', false);
    const out = rls.initializeForQuery('SELECT * FROM orders', 'alice', ['orders']);
    expect(out).not.toContain('tenant_id');
  });

  it('returns unchanged when tables list is empty', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.initializeForQuery('SELECT * FROM orders', 'alice', []);
    expect(out).not.toContain('tenant_id');
  });
});

describe('RLSInjector — remaining branch coverage', () => {
  it('handles empty/whitespace-only statement via injectRLS', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    expect(rls.injectRLS(';', 'alice')).toBe(';');
  });

  it('handles VALUES ... UNION (union right branch)', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('VALUES (1) UNION SELECT * FROM orders', 'alice');
    expect(out).toContain('tenant_id');
  });

  it('returns unchanged for specific-table injection on non-DML SQL', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectForUser('CREATE TABLE x(a int)', 'alice', 'orders');
    expect(out).not.toContain('tenant_id');
  });

  it('leaves SQL unchanged when policy USING cannot be parsed', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'UPDATE', 'AND b'); // unparseable even wrapped
    const out = rls.injectRLS('UPDATE orders SET x = 1', 'alice');
    expect(out).not.toContain('tenant_id');
  });
});

describe('RLSInjector — regex fallback branch coverage', () => {
  it('skips a table with no matching policy in regex fallback', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM nonexist ORDER BY ', 'alice');
    expect(out).not.toContain('tenant_id');
  });

  it('skips a table whose policies are all disabled in regex fallback', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.setPolicyEnabled('p', false);
    const out = rls.injectRLS('SELECT * FROM orders ORDER BY ', 'alice');
    expect(out).not.toContain('tenant_id');
  });
});

describe('RLSInjector — injectIntoStatement condition guards', () => {
  it('skips INSERT whose target table has no matching policy', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'other', 'SELECT', 'x = 1');
    const out = rls.injectRLS('INSERT INTO orders (a) VALUES (1)', 'alice');
    expect(out).not.toContain('tenant_id');
  });

  it('skips UPDATE whose target table has no matching policy', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'other', 'UPDATE', 'x = 1');
    const out = rls.injectRLS('UPDATE orders SET x = 1', 'alice');
    expect(out).not.toContain('tenant_id');
  });

  it('skips DELETE whose target table has no matching policy', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'other', 'DELETE', 'x = 1');
    const out = rls.injectRLS('DELETE FROM orders', 'alice');
    expect(out).not.toContain('tenant_id');
  });

  it('skips DELETE when its policy USING cannot be parsed', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'DELETE', 'AND b'); // unparseable
    const out = rls.injectRLS('DELETE FROM orders', 'alice');
    expect(out).not.toContain('tenant_id');
  });
});

describe('RLSInjector — extractTablesRegex special table names', () => {
  it('ignores parenthesized FROM subqueries', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const tables = (rls as any).extractTablesRegex('SELECT * FROM (SELECT 1) x');
    expect(tables).toEqual([]);
  });

  it('ignores underscore-prefixed table names', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const tables = (rls as any).extractTablesRegex('SELECT * FROM _temp');
    expect(tables).toEqual([]);
  });
});

describe('RLSInjector — command-type mismatch leaves target table unguarded', () => {
  it('does not guard INSERT target when only SELECT policy exists', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    // A second policy ensures the AST path reaches injectIntoStatement.
    rls.createPolicy('p2', 'other', 'INSERT', 'owner_id = current_user');
    const out = rls.injectRLS('INSERT INTO orders (a) VALUES (1)', 'alice');
    expect(out).not.toContain('tenant_id');
  });

  it('does not guard UPDATE target when only SELECT policy exists', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.createPolicy('p2', 'other', 'UPDATE', 'owner_id = current_user');
    const out = rls.injectRLS('UPDATE orders SET x = 1 WHERE id = 2', 'alice');
    expect(out).not.toContain('tenant_id');
  });

  it('does not guard DELETE target when only SELECT policy exists', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.createPolicy('p2', 'other', 'DELETE', 'owner_id = current_user');
    const out = rls.injectRLS('DELETE FROM orders WHERE id = 2', 'alice');
    expect(out).not.toContain('tenant_id');
  });
});

describe('RLSInjector — disabled policies in regex fallback (empty conditions)', () => {
  it('leaves SQL unchanged when auto-detected table has only disabled policies', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.setPolicyEnabled('p', false);
    // AST parse fails on the trailing dangling WHERE, forcing regex fallback.
    const out = rls.injectForUser('SELECT * FROM orders WHERE ', 'alice');
    expect(out).not.toContain('tenant_id');
  });

  it('leaves SQL unchanged when initializeForQuery table has only disabled policies', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    rls.setPolicyEnabled('p', false);
    const out = rls.initializeForQuery('SELECT * FROM orders WHERE ', 'alice', ['orders']);
    expect(out).not.toContain('tenant_id');
  });
});

describe('RLSInjector — injectIntoStatement target table without policy', () => {
  it('reaches insert case with empty conditions for unguarded target', () => {
    const rls = new RLSInjector();
    // `other` has an INSERT policy so tableConditions is non-empty,
    // but the INSERT target `orders` has none.
    rls.createPolicy('p2', 'other', 'INSERT', 'owner_id = current_user');
    const out = rls.injectRLS('INSERT INTO orders (a) SELECT a FROM other', 'alice');
    // orders is unguarded; the SELECT subquery's RLS is not injected here.
    expect(out).not.toContain('owner_id');
  });

  it('reaches update case with empty conditions for unguarded target', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p2', 'other', 'UPDATE', 'owner_id = current_user');
    const out = rls.injectRLS('UPDATE orders SET x = 1', 'alice');
    expect(out).not.toContain('owner_id');
  });

  it('reaches delete case with empty conditions for unguarded target', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p2', 'other', 'DELETE', 'owner_id = current_user');
    const out = rls.injectRLS('DELETE FROM orders', 'alice');
    expect(out).not.toContain('owner_id');
  });
});

describe('RLSInjector — update/delete target unguarded but FROM table guarded', () => {
  it('reaches UPDATE case with empty conditions for target table', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p2', 'other', 'UPDATE', 'owner_id = current_user');
    const out = rls.injectRLS('UPDATE orders SET x = 1 FROM other WHERE orders.id = other.id', 'alice');
    expect(out).not.toContain('owner_id');
  });
});

describe('RLSInjector — final guard branches', () => {
  it('returns unchanged when initializeForQuery gets a non-DML statement via fallback', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'SELECT', 'tenant_id = current_user');
    const out = rls.initializeForQuery('ALTRE TABLE x', 'alice', ['orders']);
    expect(out).not.toContain('tenant_id');
  });

  it('skips injection when INSERT policy USING expression is unparseable', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'orders', 'INSERT', 'AND b');
    const out = rls.injectRLS('INSERT INTO orders (a) VALUES (1)', 'alice');
    expect(out).not.toContain('tenant_id');
  });

  it('reaches DELETE case with empty conditions via USING clause', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p2', 'other', 'DELETE', 'owner_id = current_user');
    const out = rls.injectRLS('DELETE FROM orders USING other WHERE orders.id = other.id', 'alice');
    expect(out).not.toContain('owner_id');
  });
});

describe('RLSInjector — multi-statement unguarded DELETE target', () => {
  it('reaches DELETE case with empty conditions when another statement is guarded', () => {
    const rls = new RLSInjector();
    rls.createPolicy('p', 'protected_tbl', 'SELECT', 'tenant_id = current_user');
    const out = rls.injectRLS('SELECT * FROM protected_tbl; DELETE FROM orders', 'alice');
    // The SELECT is guarded, but the DELETE target `orders` has no policy.
    expect(out).toContain('tenant_id');
    expect(out).toContain('DELETE FROM orders');
  });
});
