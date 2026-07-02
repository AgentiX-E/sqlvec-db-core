/**
 * RLSInjector — Row-Level Security policy injector with AST-based SQL rewriting.
 *
 * Implements PostgreSQL-compatible row-level security (RLS) by injecting
 * USING clauses as WHERE predicates into DML queries at execution time.
 *
 * Uses `pgsql-ast-parser` to parse SQL into an AST, find all table references
 * (including JOINs, subqueries, and CTEs), and inject RLS conditions into the
 * WHERE clause of each matching statement.
 *
 * ## Design
 *
 * When a policy is created, it is associated with a table, command type
 * (SELECT, INSERT, UPDATE, DELETE), and a USING expression (e.g. `tenant_id =
 * current_user`). When a query targets a table that has active policies, the
 * RLSInjector rewrites the SQL to append the policy's USING clause as an
 * additional WHERE condition.
 *
 * ## Example
 *
 * ```
 * // Policy: "users can only see their own tenant's rows"
 * rls.createPolicy('tenant_policy', 'orders', 'SELECT', 'tenant_id = current_user');
 *
 * // Original:  SELECT * FROM orders
 * // Rewritten: SELECT * FROM orders WHERE (tenant_id = current_user)
 * ```
 *
 * @module query/RLSInjector
 */

import { PinoLogger } from '../logger/PinoLogger';
import { parse, toSql } from 'pgsql-ast-parser';
import type {
  Statement,
  SelectStatement,
  SelectFromStatement,
  SelectFromUnion,
  WithStatement,
  WithRecursiveStatement,
  UpdateStatement,
  DeleteStatement,
  From,
  FromTable,
  FromStatement,
  Expr,
  ExprBinary,
  QNameAliased,
} from 'pgsql-ast-parser';

// ── Logger ───────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────

export type RLSCommand = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';

export interface RLSPolicy {
  /** Policy name (unique per table + command combination). */
  name: string;
  /** Target table name (qualified). */
  table: string;
  /** DML command this policy applies to. */
  command: RLSCommand;
  /** USING expression (the WHERE clause fragment to inject). */
  using: string;
  /** Whether this policy is currently active. */
  enabled: boolean;
}

// ── SQL pattern helpers (fallback) ───────────────────────────────

/**
 * Regex to locate a FROM clause and its following WHERE/GROUP/ORDER/LIMIT.
 * Used for fallback injection when AST parsing fails.
 */
const FROM_CLAUSE_RE = /\bFROM\s+([`"\w.]+)(?:\s+(?:AS\s+)?[`"\w]+)?/i;

/**
 * Matches a WHERE clause (simple, single-level) — fallback.
 */
const WHERE_CLAUSE_RE = /\bWHERE\s+(.+?)(?=\s+(?:GROUP|ORDER|LIMIT|HAVING|WINDOW|\))|$)/is;

// ── RLSInjector ──────────────────────────────────────────────────

export class RLSInjector {
  private readonly logger = PinoLogger.forComponent('rlsinjector');

  private policies: Map<string, RLSPolicy> = new Map();

  /**
   * Create and register a new RLS policy.
   *
   * The policy is stored keyed by its unique name. Policies are matched
   * to SQL statements by (table, command) at injection time — no automatic
   * 'ALL' policies are generated.
   *
   * @param name    - Unique policy name.
   * @param table   - Target table name.
   * @param command - DML command type ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL').
   * @param using   - USING expression (e.g. `tenant_id = current_user`).
   */
  createPolicy(name: string, table: string, command: RLSCommand, using: string): void {
    const policy: RLSPolicy = { name, table, command, using, enabled: true };
    this.policies.set(name, policy);

    this.logger.info({ name, table, command, using }, 'RLS policy created');
  }

  /**
   * Drop an existing RLS policy by name.
   *
   * @param name - Name of the policy to drop.
   */
  dropPolicy(name: string): void {
    this.policies.delete(name);
    this.logger.info({ name }, 'RLS policy dropped');
  }

  /**
   * Drop all policies for a given table.
   *
   * @param table - Table name.
   */
  dropAllPoliciesForTable(table: string): void {
    const keysToDelete: string[] = [];
    for (const [key, policy] of this.policies) {
      if (policy.table === table) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.policies.delete(key);
    }

    this.logger.info({ table, removed: keysToDelete.length }, 'All RLS policies dropped for table');
  }

  /**
   * Inject RLS policies into a SQL query.
   *
   * Parses the SQL using `pgsql-ast-parser`, identifies all table references
   * (including JOINs, subqueries, CTEs), and injects matching RLS conditions
   * into the WHERE clause of each statement.
   *
   * Falls back to regex-based injection if AST parsing fails.
   *
   * @param sql         - The original SQL statement.
   * @param currentUser - The current database user (for `current_user` substitution).
   * @returns The rewritten SQL with RLS conditions injected.
   */
  injectRLS(sql: string, currentUser: string): string {
    if (this.policies.size === 0) return sql;

    // Try AST-based approach, fall back to regex on failure
    try {
      return this.injectRLSviaAST(sql, currentUser);
    } catch (err) {
      this.logger.warn({ err }, 'AST-based RLS injection failed, falling back to regex');
      return this.injectRLSviaRegex(sql, currentUser);
    }
  }

  /**
   * Enable or disable a policy by name.
   *
   * @param name    - Policy name.
   * @param enabled - Whether to enable (`true`) or disable (`false`).
   */
  setPolicyEnabled(name: string, enabled: boolean): void {
    for (const policy of this.policies.values()) {
      if (policy.name === name) {
        policy.enabled = enabled;
      }
    }
    this.logger.info({ name, enabled }, 'RLS policy enabled state changed');
  }

  /**
   * Get a list of all registered policies.
   */
  getAllPolicies(): RLSPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Get policies for a specific table.
   *
   * @param table - Table name.
   */
  getPoliciesForTable(table: string): RLSPolicy[] {
    return Array.from(this.policies.values()).filter((p) => p.table === table);
  }

  /**
   * Reset all policies (for testing).
   */
  reset(): void {
    this.policies.clear();
    this.logger.info('RLS state reset');
  }

  // ── G20: RLS Pipeline Integration ─────────────────────────────

  /**
   * Inject RLS policies for a given user into a SQL query.
   * This is the main entry point for QueryRouter integration.
   * Automatically detects the table(s) from the SQL and applies
   * matching policies for the user.
   *
   * @param sql   - The original SQL query
   * @param user  - The database user executing the query
   * @param table - Optional specific table to restrict injection to
   * @returns Rewritten SQL with RLS conditions
   */
  injectForUser(sql: string, user: string, table?: string): string {
    if (this.policies.size === 0) return sql;

    let result = sql;

    if (table) {
      // Inject for a specific table only
      const stmtType = this.detectStatementType(sql);
      if (!stmtType) return sql;

      const matchingPolicies = this.getMatchingPolicies(table, stmtType);
      const conditions = matchingPolicies
        .filter((p) => p.enabled)
        .map((p) => this.substituteUser(p.using, user));

      if (conditions.length > 0) {
        const rlsCondition = conditions.join(' AND ');
        result = this.injectWhereClauseRegex(result, rlsCondition);
      }
    } else {
      // Auto-detect tables and inject for all
      try {
        result = this.injectRLSviaAST(sql, user);
      } catch {
        const tables = this.extractTablesRegex(sql);
        const stmtType = this.detectStatementType(sql);
        if (!stmtType) return sql;

        for (const t of tables) {
          const matchingPolicies = this.getMatchingPolicies(t, stmtType);
          const conditions = matchingPolicies
            .filter((p) => p.enabled)
            .map((p) => this.substituteUser(p.using, user));

          if (conditions.length > 0) {
            const rlsCondition = conditions.join(' AND ');
            result = this.injectWhereClauseRegex(result, rlsCondition);
          }
        }
      }
    }

    if (result !== sql) {
      this.logger.debug(
        { user, original: sql.substring(0, 80), rewritten: result.substring(0, 80) },
        'RLS injected for user',
      );
    }

    return result;
  }

  /**
   * Initialize RLS for a full query, injecting policies for all
   * relevant tables in a single pass.
   *
   * @param sql    - The original SQL query
   * @param user   - The database user
   * @param tables - Array of table names to inject policies for
   * @returns Rewritten SQL
   */
  initializeForQuery(sql: string, user: string, tables: string[]): string {
    if (this.policies.size === 0 || tables.length === 0) return sql;

    try {
      return this.injectRLSviaAST(sql, user);
    } catch {
      // Fallback
    }

    const stmtType = this.detectStatementType(sql);
    if (!stmtType) return sql;

    let result = sql;

    for (const table of tables) {
      const matchingPolicies = this.getMatchingPolicies(table, stmtType);
      const conditions = matchingPolicies
        .filter((p) => p.enabled)
        .map((p) => this.substituteUser(p.using, user));

      if (conditions.length > 0) {
        const rlsCondition = conditions.join(' AND ');
        result = this.injectWhereClauseRegex(result, rlsCondition);
      }
    }

    return result;
  }

  /**
   * Get all active policies for a specific table.
   * Returns only enabled policies.
   *
   * @param table - Table name
   * @returns Array of enabled RLSPolicy objects
   */
  getActivePolicies(table: string): RLSPolicy[] {
    return Array.from(this.policies.values()).filter(
      (p) => p.table === table && p.enabled,
    );
  }

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Detect the SQL statement type from the first keyword.
   */
  private detectStatementType(sql: string): RLSCommand | null {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) return 'SELECT';
    if (trimmed.startsWith('INSERT')) return 'INSERT';
    if (trimmed.startsWith('UPDATE')) return 'UPDATE';
    if (trimmed.startsWith('DELETE')) return 'DELETE';
    return null;
  }

  /**
   * Get all policies matching a table and command.
   * Matches both exact command and ALL policies.
   */
  private getMatchingPolicies(table: string, command: RLSCommand): RLSPolicy[] {
    const result: RLSPolicy[] = [];
    for (const policy of this.policies.values()) {
      if (policy.table !== table) continue;
      if (policy.command === command || policy.command === 'ALL') {
        result.push(policy);
      }
    }
    return result;
  }

  /**
   * Substitute `current_user` placeholders with the actual username.
   */
  private substituteUser(usingExpr: string, currentUser: string): string {
    return usingExpr.replace(/\bcurrent_user\b/gi, `'${currentUser.replace(/'/g, "''")}'`);
  }

  // ── AST-based injection ─────────────────────────────────────────

  /**
   * Inject RLS conditions using AST parsing.
   */
  private injectRLSviaAST(sql: string, currentUser: string): string {
    const stmts = parse(sql);
    if (stmts.length === 0) return sql;

    const stmtType = this.detectStatementType(sql);
    if (!stmtType) return sql;

    // 1. Collect all table names referenced across all statements
    const allTables = new Set<string>();
    for (const stmt of stmts) {
      this.collectTablesFromStatement(stmt, allTables);
    }

    // 2. Build table → conditions map
    const tableConditions = new Map<string, string[]>();
    for (const tableName of allTables) {
      const policies = this.getMatchingPolicies(tableName, stmtType);
      const conditions = policies
        .filter((p) => p.enabled)
        .map((p) => this.substituteUser(p.using, currentUser));
      if (conditions.length > 0) {
        tableConditions.set(tableName, conditions);
      }
    }

    if (tableConditions.size === 0) return sql;

    // 3. Modify each statement to inject conditions
    const modified = stmts.map((stmt) => this.injectIntoStatement(stmt, tableConditions));

    // 4. Serialize back to SQL
    const result = modified.map((s) => toSql.statement(s)).join(';\n');

    this.logger.debug(
      { original: sql.substring(0, 100), rewritten: result.substring(0, 100) },
      'RLS injected (AST)',
    );

    return result;
  }

  /**
   * Recursively collect all table names from a statement.
   * Handles SELECT, UPDATE, DELETE, WITH, WITH RECURSIVE, unions, and subqueries.
   */
  private collectTablesFromStatement(stmt: Statement, tables: Set<string>): void {
    if (!stmt || typeof stmt !== 'object') return;

    // Handle union types
    if ('type' in stmt === false) return;

    switch (stmt.type) {
      case 'select': {
        this.collectTablesFromSelect(stmt as SelectFromStatement, tables);
        break;
      }
      case 'union':
      case 'union all': {
        const union = stmt as SelectFromUnion;
        this.collectTablesFromStatement(union.left, tables);
        this.collectTablesFromStatement(union.right, tables);
        break;
      }
      case 'with': {
        const withStmt = stmt as WithStatement;
        // Recurse into CTE bindings
        for (const binding of withStmt.bind) {
          this.collectTablesFromStatement(binding.statement, tables);
        }
        // Recurse into the main statement
        this.collectTablesFromStatement(withStmt.in, tables);
        break;
      }
      case 'with recursive': {
        const withRec = stmt as WithRecursiveStatement;
        this.collectTablesFromStatement(withRec.bind, tables);
        this.collectTablesFromStatement(withRec.in, tables);
        break;
      }
      case 'update': {
        const update = stmt as UpdateStatement;
        // The target table
        if (update.table && update.table.name) {
          tables.add(update.table.name);
        }
        // FROM clause (for UPDATE ... FROM)
        if (update.from) {
          this.collectTablesFromFromArray(Array.isArray(update.from) ? update.from : [update.from], tables);
        }
        break;
      }
      case 'delete': {
        const del = stmt as DeleteStatement;
        if (del.from && del.from.name) {
          tables.add(del.from.name);
        }
        break;
      }
      // For non-DML statements, skip
      default:
        break;
    }
  }

  /**
   * Collect table names from a SELECT statement's FROM clause.
   */
  private collectTablesFromSelect(select: SelectFromStatement, tables: Set<string>): void {
    if (!select.from) return;
    this.collectTablesFromFromArray(select.from, tables);

    // Also check WHERE clause for subqueries
    if (select.where) {
      this.collectTablesFromExpr(select.where, tables);
    }
  }

  /**
   * Collect table names from an array of FROM sources.
   * Handles regular tables, statement subqueries, and JOIN chains.
   */
  private collectTablesFromFromArray(fromArray: From[], tables: Set<string>): void {
    for (const from of fromArray) {
      this.collectTableFromFromSource(from, tables);
    }
  }

  /**
   * Collect table names from a single FROM source (possibly with JOIN chain).
   */
  private collectTableFromFromSource(from: From, tables: Set<string>): void {
    switch (from.type) {
      case 'table': {
        const ft = from as FromTable;
        if (ft.name && ft.name.name) {
          tables.add(ft.name.name);
        }
        // Recurse into JOIN chain
        if (ft.join) {
          // The join has an ON/USING clause but the joined table is another FromTable
          // in the same `from` array, not in the join clause itself
        }
        break;
      }
      case 'statement': {
        // Subquery — recurse into the inner statement
        const fs = from as FromStatement;
        this.collectTablesFromStatement(fs.statement, tables);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Recursively collect table references from expressions (e.g., subqueries in WHERE).
   */
  private collectTablesFromExpr(expr: Expr, tables: Set<string>): void {
    if (!expr || typeof expr !== 'object') return;

    if ('type' in expr === false) return;

    switch (expr.type) {
      case 'select':
        this.collectTablesFromSelect(expr as SelectFromStatement, tables);
        break;
      case 'binary': {
        const bin = expr as ExprBinary;
        this.collectTablesFromExpr(bin.left, tables);
        this.collectTablesFromExpr(bin.right, tables);
        break;
      }
      case 'unary': {
        const un = expr as any;
        if (un.operand) this.collectTablesFromExpr(un.operand, tables);
        break;
      }
      case 'call': {
        const call = expr as any;
        if (call.args) {
          for (const arg of call.args) {
            this.collectTablesFromExpr(arg, tables);
          }
        }
        break;
      }
      case 'list':
      case 'array': {
        const list = expr as any;
        if (list.expressions) {
          for (const e of list.expressions) {
            this.collectTablesFromExpr(e, tables);
          }
        }
        break;
      }
      case 'case': {
        const c = expr as any;
        if (c.value) this.collectTablesFromExpr(c.value, tables);
        if (c.whens) {
          for (const w of c.whens) {
            if (w.when) this.collectTablesFromExpr(w.when, tables);
            if (w.value) this.collectTablesFromExpr(w.value, tables);
          }
        }
        if (c.else) this.collectTablesFromExpr(c.else, tables);
        break;
      }
      case 'cast': {
        const cast = expr as any;
        if (cast.operand) this.collectTablesFromExpr(cast.operand, tables);
        break;
      }
      default:
        break;
    }
  }

  // ── AST modification ──────────────────────────────────────────

  /**
   * Inject RLS conditions into a single statement.
   * Handles SELECT, UPDATE, DELETE, and their nested variants.
   */
  private injectIntoStatement(stmt: Statement, tableConditions: Map<string, string[]>): Statement {
    if (!stmt || typeof stmt !== 'object') return stmt;
    if ('type' in stmt === false) return stmt;

    switch (stmt.type) {
      case 'select': {
        const select = stmt as SelectFromStatement;
        const tablesInStmt = new Set<string>();
        this.collectTablesFromSelect(select, tablesInStmt);
        return this.injectWhereIntoSelect(select, tablesInStmt, tableConditions);
      }
      case 'union':
      case 'union all': {
        const union = stmt as SelectFromUnion;
        union.left = this.injectIntoStatement(union.left, tableConditions) as SelectStatement;
        union.right = this.injectIntoStatement(union.right, tableConditions) as SelectStatement;
        return union;
      }
      case 'with': {
        const withStmt = stmt as WithStatement;
        // Recurse into CTE bindings
        withStmt.bind = withStmt.bind.map((b) => ({
          ...b,
          statement: this.injectIntoStatement(b.statement, tableConditions) as any,
        }));
        // Recurse into the main statement
        withStmt.in = this.injectIntoStatement(withStmt.in, tableConditions) as any;
        return withStmt;
      }
      case 'with recursive': {
        const withRec = stmt as WithRecursiveStatement;
        withRec.bind = this.injectIntoStatement(withRec.bind, tableConditions) as any;
        withRec.in = this.injectIntoStatement(withRec.in, tableConditions) as any;
        return withRec;
      }
      case 'update': {
        const update = stmt as UpdateStatement;
        if (update.table && update.table.name) {
          const tableName = update.table.name;
          const conditions = tableConditions.get(tableName);
          if (conditions && conditions.length > 0) {
            const condExpr = this.parseConditionExpr(conditions.join(' AND '));
            if (condExpr) {
              if (update.where) {
                update.where = this.makeBinary(update.where, 'AND', condExpr);
              } else {
                update.where = condExpr;
              }
            }
          }
        }
        return update;
      }
      case 'delete': {
        const del = stmt as DeleteStatement;
        if (del.from && del.from.name) {
          const tableName = del.from.name;
          const conditions = tableConditions.get(tableName);
          if (conditions && conditions.length > 0) {
            const condExpr = this.parseConditionExpr(conditions.join(' AND '));
            if (condExpr) {
              if (del.where) {
                del.where = this.makeBinary(del.where, 'AND', condExpr);
              } else {
                del.where = condExpr;
              }
            }
          }
        }
        // Also check FROM clause if DELETE has complex from
        return del;
      }
      default:
        return stmt;
    }
  }

  /**
   * Inject RLS conditions into a SELECT statement's WHERE clause based on
   * the tables referenced in its FROM clause.
   */
  private injectWhereIntoSelect(
    select: SelectFromStatement,
    tablesInStmt: Set<string>,
    tableConditions: Map<string, string[]>,
  ): SelectFromStatement {
    // Build combined condition from all matching tables
    const conditions: string[] = [];
    for (const tableName of tablesInStmt) {
      const conds = tableConditions.get(tableName);
      if (conds) {
        conditions.push(...conds);
      }
    }

    if (conditions.length === 0) return select;

    const combinedCondition = conditions.join(' AND ');
    const condExpr = this.parseConditionExpr(combinedCondition);
    if (!condExpr) return select;

    if (select.where) {
      select.where = this.makeBinary(select.where, 'AND', condExpr);
    } else {
      select.where = condExpr;
    }

    return select;
  }

  /**
   * Parse a condition expression string into an AST Expr.
   * Returns null if parsing fails.
   */
  private parseConditionExpr(conditionStr: string): Expr | null {
    try {
      const expr = parse(conditionStr, 'expr');
      return expr;
    } catch {
      // If we can't parse as expression, try wrapping in parentheses
      try {
        return parse(`(${conditionStr})`, 'expr');
      } catch {
        return null;
      }
    }
  }

  /**
   * Create a binary AND expression.
   */
  private makeBinary(left: Expr, op: 'AND', right: Expr): ExprBinary {
    return {
      type: 'binary',
      left,
      right,
      op,
    };
  }

  // ── Regex-based injection (fallback) ──────────────────────────

  /**
   * Fallback regex-based RLS injection.
   * Mimics the original implementation for backward compatibility.
   */
  private injectRLSviaRegex(sql: string, currentUser: string): string {
    const stmtType = this.detectStatementType(sql);
    if (!stmtType) return sql;

    let resultSql = sql;

    // Collect all table references using regex
    const tables = this.extractTablesRegex(sql);

    for (const table of tables) {
      const matchingPolicies = this.getMatchingPolicies(table, stmtType);
      if (matchingPolicies.length === 0) continue;

      const conditions = matchingPolicies
        .filter((p) => p.enabled)
        .map((p) => this.substituteUser(p.using, currentUser));

      if (conditions.length === 0) continue;

      const rlsCondition = conditions.join(' AND ');
      resultSql = this.injectWhereClauseRegex(resultSql, rlsCondition);
    }

    return resultSql;
  }

  /**
   * Extract table names referenced in the FROM clause using regex (fallback).
   */
  private extractTablesRegex(sql: string): string[] {
    const tables: string[] = [];
    const match = sql.match(FROM_CLAUSE_RE);
    if (match) {
      const tableName = match[1].replace(/[`"']/g, '');
      if (!tableName.startsWith('(') && !tableName.startsWith('_')) {
        tables.push(tableName);
      }
    }
    return tables;
  }

  /**
   * Inject a WHERE condition using regex (fallback).
   */
  private injectWhereClauseRegex(sql: string, condition: string): string {
    const whereMatch = sql.match(WHERE_CLAUSE_RE);
    if (whereMatch) {
      const afterWhere = whereMatch[0];
      const newWhere = afterWhere + ` AND (${condition})`;
      return sql.replace(afterWhere, newWhere);
    }

    const insertBefore = ['GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'HAVING', ';'];
    let bestIndex = sql.length;

    for (const keyword of insertBefore) {
      const idx = sql.toUpperCase().indexOf(keyword);
      if (idx !== -1 && idx < bestIndex) {
        bestIndex = idx;
      }
    }

    const before = sql.substring(0, bestIndex);
    const after = sql.substring(bestIndex);
    return `${before} WHERE (${condition}) ${after}`.trim();
  }
}
