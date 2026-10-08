import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ExplainHandler, DEFAULT_EXPLAIN_OPTIONS } from '../query/ExplainHandler';

describe('ExplainHandler', () => {
  function makeHandler(db?: Database.Database) {
    return new ExplainHandler(undefined, db);
  }

  describe('isExplainStatement', () => {
    it('detects EXPLAIN and EXPLAIN ANALYZE', () => {
      expect(ExplainHandler.isExplainStatement('EXPLAIN SELECT 1')).toBe(true);
      expect(ExplainHandler.isExplainStatement('  explain analyze select 1')).toBe(true);
      expect(ExplainHandler.isExplainStatement('SELECT 1')).toBe(false);
    });
  });

  describe('stripExplain', () => {
    it('strips parenthetical EXPLAIN options', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN (FORMAT JSON) SELECT * FROM t');
      expect(r.options.format).toBe('json');
      expect(r.innerSql).toContain('SELECT');
    });

    it('strips EXPLAIN ANALYZE VERBOSE', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN ANALYZE VERBOSE SELECT * FROM t');
      expect(r.options.analyze).toBe(true);
      expect(r.options.verbose).toBe(true);
    });

    it('strips EXPLAIN ANALYZE', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN ANALYZE SELECT * FROM t');
      expect(r.options.analyze).toBe(true);
    });

    it('strips EXPLAIN VERBOSE', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN VERBOSE SELECT * FROM t');
      expect(r.options.verbose).toBe(true);
    });

    it('strips plain EXPLAIN', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN SELECT * FROM t');
      expect(r.innerSql).toContain('SELECT');
    });

    it('handles bare EXPLAIN', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN');
      expect(r.innerSql).toBe('');
    });

    it('parses ANALYZE, VERBOSE, COSTS FALSE, TIMING FALSE, BUFFERS', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN (ANALYZE, VERBOSE, COSTS FALSE, TIMING FALSE, BUFFERS, FORMAT YAML) SELECT 1');
      expect(r.options.analyze).toBe(true);
      expect(r.options.verbose).toBe(true);
      expect(r.options.costs).toBe(false);
      expect(r.options.timing).toBe(false);
      expect(r.options.buffers).toBe(true);
      expect(r.options.format).toBe('yaml');
    });

    it('parses FORMAT TEXT', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN (FORMAT TEXT) SELECT 1');
      expect(r.options.format).toBe('text');
    });

    it('parses COSTS, TIMING, BUFFERS (boolean true), and FORMAT JSON', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN (COSTS, TIMING, BUFFERS, FORMAT JSON) SELECT 1');
      expect(r.options.costs).toBe(true);
      expect(r.options.timing).toBe(true);
      expect(r.options.buffers).toBe(true);
      expect(r.options.format).toBe('json');
    });

    it('parses COSTS OFF and TIMING OFF', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN (COSTS OFF, TIMING OFF) SELECT 1');
      expect(r.options.costs).toBe(false);
      expect(r.options.timing).toBe(false);
    });

    it('ignores unknown options in the parenthetical list', () => {
      const r = ExplainHandler.stripExplain('EXPLAIN (ANALYZE, SETTINGS, FORMAT JSON) SELECT 1');
      expect(r.options.analyze).toBe(true);
      expect(r.options.format).toBe('json');
    });

    it('passes through non-EXPLAIN SQL unchanged', () => {
      const r = ExplainHandler.stripExplain('SELECT * FROM users');
      expect(r.innerSql).toBe('SELECT * FROM users');
      expect(r.options.analyze).toBe(false);
    });
  });

  describe('buildPlan (text, no db)', () => {
    it('builds a simple SELECT plan', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users WHERE id = 1');
      expect(r.summary.hasVectorSearch).toBe(false);
      expect(r.planNodes.length).toBeGreaterThan(0);
      expect(r.planNodes[0].nodeType).toBe('Index Scan');
      expect(r.planNodes[0].relationName).toBe('users');
    });

    it('builds a Seq Scan for non-PK column', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users WHERE name = \'alice\'');
      expect(r.planNodes[0].nodeType).toBe('Seq Scan');
    });

    it('builds plan for SELECT with GROUP BY aggregate', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT count(*) FROM users GROUP BY age');
      expect(r.planNodes[0].nodeType).toBe('Aggregate');
    });

    it('builds plan for ORDER BY', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users ORDER BY name DESC, id ASC');
      expect(r.planNodes[0].nodeType).toBe('Sort');
      expect(r.planNodes[0].sortKey).toContain('DESC');
    });

    it('builds plan for LIMIT', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users LIMIT 5');
      expect(r.planNodes[0].nodeType).toBe('Limit');
      expect(r.planNodes[0].planRows).toBe(5);
    });

    it('builds plan for JOIN', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT a, b FROM t1 JOIN t2 ON t1.id = t2.id');
      expect(r.planNodes[0].nodeType).toBe('Hash Join');
    });

    it('builds an INSERT plan', () => {
      const h = makeHandler();
      const r = h.buildPlan("INSERT INTO users (name) VALUES ('a')");
      expect(r.planNodes[0].nodeType).toBe('Insert');
      expect(r.planNodes[0].relationName).toBe('users');
    });

    it('builds an UPDATE plan', () => {
      const h = makeHandler();
      const r = h.buildPlan("UPDATE users SET name = 'x' WHERE id = 1");
      expect(r.planNodes[0].nodeType).toBe('Update');
    });

    it('builds a DELETE plan', () => {
      const h = makeHandler();
      const r = h.buildPlan('DELETE FROM users WHERE id = 1');
      expect(r.planNodes[0].nodeType).toBe('Delete');
    });

    it('builds a DDL plan', () => {
      const h = makeHandler();
      const r = h.buildPlan('CREATE TABLE foo (id int)');
      expect(r.planNodes[0].nodeType).toBe('Create Table');
    });

    it('builds an unknown plan for unparseable SQL', () => {
      const h = makeHandler();
      const r = h.buildPlan('THIS IS NOT SQL');
      expect(r.planNodes[0].nodeType).toBe('Custom Scan');
    });
  });

  describe('with a real database', () => {
    let db: Database.Database;
    beforeEach(() => {
      db = new Database(':memory:');
      db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      db.exec("INSERT INTO users VALUES (1, 'alice'), (2, 'bob'), (3, 'carol')");
    });
    afterEach(() => db.close());

    it('uses real row count from the database', () => {
      const h = makeHandler(db);
      const r = h.buildPlan('SELECT * FROM users');
      expect(r.planNodes[0].planRows).toBe(3);
    });
  });

  describe('vector search', () => {
    it('builds a vector search plan', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM vec_search(embedding, \'[1,2,3]\') LIMIT 10');
      // NOTE: depends on the VEC_SEARCH detection
      expect(r.summary.hasVectorSearch).toBe(true);
    });
  });

  describe('formatExplaitOutput static helpers', () => {
    it('planNodeToExplainNode converts and sets ActualLoops default', () => {
      const node = ExplainHandler.planNodeToExplainNode({
        nodeType: 'Seq Scan',
        relationName: 't',
        startupCost: 0,
        totalCost: 1,
        planRows: 10,
        planWidth: 32,
      });
      expect(node.NodeType).toBe('Seq Scan');
      expect(node.ActualLoops).toBe(1);
    });

    it('explainNodeToJson produces PG-style keys', () => {
      const node = ExplainHandler.planNodeToExplainNode({
        nodeType: 'Seq Scan',
        relationName: 't',
        startupCost: 0,
        totalCost: 1,
        planRows: 10,
        planWidth: 32,
      });
      const json = ExplainHandler.explainNodeToJson(node);
      expect(json['Node Type']).toBe('Seq Scan');
      expect(json['Relation Name']).toBe('t');
    });

    it('toQueryPlanRows splits and filters blank lines', () => {
      const rows = ExplainHandler.toQueryPlanRows('a\n\nb\n');
      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual({ 'QUERY PLAN': 'a' });
    });

    it('planNodeToJson serializes with PG keys', () => {
      const json = ExplainHandler.planNodeToJson({
        nodeType: 'Seq Scan',
        relationName: 't',
        startupCost: 0,
        totalCost: 1,
        planRows: 10,
        planWidth: 32,
      });
      expect(json['Node Type']).toBe('Seq Scan');
    });

    it('planTreeToJson includes planning time and options', () => {
      const json = ExplainHandler.planTreeToJson(
        { nodeType: 'Seq Scan', relationName: 't', startupCost: 0, totalCost: 1, planRows: 10, planWidth: 32 },
        { analyze: true, verbose: false, costs: true, timing: true, format: 'json' },
        1.23,
        4.56,
      );
      expect(json['Planning Time']).toBe(1.23);
      expect(json['Execution Time']).toBe(4.56);
      expect(json['Options']).toBeDefined();
    });

    it('explainResultToRows returns query plan rows for text format', () => {
      const rows = ExplainHandler.explainResultToRows({
        planText: '  ->  Seq Scan on t',
        planNodes: [{ nodeType: 'Seq Scan', startupCost: 0, totalCost: 1, planRows: 10, planWidth: 32 }],
        planningTime: 1,
        summary: { totalEstimatedRows: 10, totalEstimatedCost: 1, nodeCount: 1, deepestLevel: 0, scanTypeCounts: { 'Seq Scan': 1 }, hasVectorSearch: false },
        outputFormat: 'text',
      } as any);
      expect(rows.length).toBe(1);
    });
  });

  describe('buildExplainPlan and formatExplainOutput', () => {
    it('buildExplainPlan returns a PostgreSQL-style ExplainNode', () => {
      const h = makeHandler();
      const node = h.buildExplainPlan('SELECT * FROM users WHERE id = 1');
      expect(node.NodeType).toBe('Index Scan');
      expect(node.RelationName).toBe('users');
    });

    it('buildPlanWithFormat produces JSON', () => {
      const h = new ExplainHandler({ format: 'json' });
      const r = h.buildPlanWithFormat('EXPLAIN (FORMAT JSON) SELECT * FROM users WHERE id = 1');
      expect(r.outputFormat).toBe('json');
      expect(r.planText).toContain('"Query Plan"');
    });

    it('buildPlanWithFormat produces YAML', () => {
      const h = new ExplainHandler({ format: 'yaml' });
      const r = h.buildPlanWithFormat('EXPLAIN (FORMAT YAML) SELECT * FROM users WHERE id = 1');
      expect(r.outputFormat).toBe('yaml');
    });

    it('buildPlanWithFormat sets executionTime only in analyze mode', () => {
      const h = new ExplainHandler({ format: 'json' });
      const r = h.buildPlanWithFormat('SELECT * FROM users WHERE id = 1');
      expect(r.executionTime).toBeUndefined();

      const h2 = new ExplainHandler({ format: 'json', analyze: true });
      const r2 = h2.buildPlanWithFormat('EXPLAIN ANALYZE SELECT * FROM users', { actualRows: 1, execTimeMs: 2.0, resultRows: [] });
      expect(r2.executionTime).toBeDefined();
    });

    it('defaults to text format when no format option is set', () => {
      const h = new ExplainHandler(); // no format -> undefined -> 'text'
      const r = h.buildPlanWithFormat('SELECT * FROM users WHERE id = 1');
      expect(r.outputFormat).toBe('text');
    });
  });

  describe('ANALYZE mode', () => {
    it('fills actuals from QueryExecutionStats', () => {
      const h = new ExplainHandler({ analyze: true });
      const stats = { actualRows: 42, execTimeMs: 12.5, resultRows: [] };
      const r = h.buildPlan('EXPLAIN ANALYZE SELECT * FROM users', stats);
      const node = r.planNodes[0];
      expect(node.actualTotalTime).toBe(12.5);
      expect(node.actualRows).toBe(42);
    });

    it('fills actuals from plain row array', () => {
      const h = new ExplainHandler({ analyze: true });
      const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const r = h.buildPlan('EXPLAIN ANALYZE SELECT * FROM users', rows);
      expect(r.planNodes[0].actualRows).toBe(3);
    });

    it('fills actuals with default rows when the result is empty', () => {
      const h = new ExplainHandler({ analyze: true });
      const r = h.buildPlan('EXPLAIN ANALYZE SELECT * FROM users', []);
      expect(r.planNodes[0].actualRows).toBe(r.planNodes[0].planRows);
    });

    it('sets executionTime on the ExplainResult in analyze mode', () => {
      const h = new ExplainHandler({ analyze: true });
      const stats = { actualRows: 1, execTimeMs: 8.2, resultRows: [] };
      const r = h.buildPlan('EXPLAIN ANALYZE SELECT * FROM users', stats);
      expect(r.executionTime).toBe(8.2);
    });
  });

  describe('exprToString via filters (AST node types)', () => {
    it('renders integer, string, float, boolean, and null literals', () => {
      const h = makeHandler();
      expect(h.buildPlan('SELECT * FROM t WHERE id = 42').planNodes[0].filter).toBe('id = 42');
      expect(h.buildPlan("SELECT * FROM t WHERE s = 'x'").planNodes[0].filter).toBe("s = 'x'");
      expect(h.buildPlan('SELECT * FROM t WHERE f = 1.5').planNodes[0].filter).toBe('f = 1.5');
      expect(h.buildPlan('SELECT * FROM t WHERE b = true').planNodes[0].filter).toBe('b = true');
      expect(h.buildPlan('SELECT * FROM t WHERE n = null').planNodes[0].filter).toBe('n = NULL');
    });

    it('renders binary, unary, and call expressions', () => {
      const h = makeHandler();
      expect(h.buildPlan('SELECT * FROM t WHERE a = 1 + 2').planNodes[0].filter).toBe('a = 1 + 2');
      expect(h.buildPlan('SELECT * FROM t WHERE -x = 5').planNodes[0].filter).toBe('- x = 5');
      expect(h.buildPlan('SELECT * FROM t WHERE y = f(a,b)').planNodes[0].filter).toBe('y = f(a, b)');
    });

    it('renders IN / NOT IN conditions', () => {
      const h = makeHandler();
      expect(h.buildPlan('SELECT * FROM t WHERE a IN (1,2)').planNodes[0].filter).toContain('IN');
      expect(h.buildPlan("SELECT * FROM t WHERE a NOT IN ('x')").planNodes[0].filter).toContain('NOT IN');
    });
  });

  describe('formatPlanTree property branches', () => {
    it('renders index, sort, strategy, hash, and join properties', () => {
      const h = makeHandler();
      // Index Scan with index name/cond via PK equality
      const idx = h.buildPlan('SELECT * FROM users WHERE id = 1');
      const idxText = h.formatPlanTree(idx.planNodes[0]);
      expect(idxText).toContain('Index Scan');

      // Sort
      const sort = h.buildPlan('SELECT * FROM users ORDER BY name DESC');
      expect(h.formatPlanTree(sort.planNodes[0])).toContain('Sort Key');

      // Aggregate strategy
      const agg = h.buildPlan('SELECT count(*) FROM users GROUP BY age');
      expect(h.formatPlanTree(agg.planNodes[0])).toContain('Strategy');

      // Join with hash cond + join type
      const join = h.buildPlan('SELECT a,b FROM t1 JOIN t2 ON t1.id=t2.id');
      const jt = h.formatPlanTree(join.planNodes[0]);
      expect(jt).toContain('Hash Join');
      expect(jt).toContain('Join Type');
      expect(jt).toContain('Hash Cond');
    });

    it('renders every optional property (alias, filter, index, cond, etc.)', () => {
      const h = new ExplainHandler({ costs: true });
      const node = {
        nodeType: 'Index Scan',
        relationName: 'users',
        alias: 'u',
        startupCost: 0,
        totalCost: 1,
        planRows: 1,
        planWidth: 32,
        filter: 'id = 1',
        indexName: 'users_pkey',
        indexCond: 'id = 1',
        sortKey: 'name DESC',
        strategy: 'HashAggregate',
        hashCond: 't1.id = t2.id',
        joinType: 'INNER',
        plans: [{ nodeType: 'Seq Scan', relationName: 'x', startupCost: 0, totalCost: 1, planRows: 10, planWidth: 32 }],
      };
      const txt = h.formatPlanTree(node);
      expect(txt).toContain('on users u');
      expect(txt).toContain('Filter:');
      expect(txt).toContain('Index: users_pkey');
      expect(txt).toContain('Index Cond:');
      expect(txt).toContain('Sort Key:');
      expect(txt).toContain('Strategy:');
      expect(txt).toContain('Hash Cond:');
      expect(txt).toContain('Join Type:');
    });

    it('renders a bare node (all optional properties absent)', () => {
      const h = new ExplainHandler({ costs: false });
      const bare = { nodeType: 'Seq Scan', startupCost: 0, totalCost: 1, planRows: 10, planWidth: 32 };
      const txt = h.formatPlanTree(bare);
      expect(txt).toContain('Seq Scan');
      expect(txt).not.toContain(' on ');
      expect(txt).not.toContain('Filter:');
    });

    it('omits cost part when costs is false', () => {
      const h = new ExplainHandler({ costs: false });
      const r = h.buildPlan('SELECT * FROM users');
      expect(h.formatPlanTree(r.planNodes[0])).not.toContain('cost=');
    });

    it('includes actual timing when analyze and actuals present', () => {
      const h = new ExplainHandler({ analyze: true });
      const r = h.buildPlan('EXPLAIN ANALYZE SELECT * FROM users', { actualRows: 5, execTimeMs: 3.0, resultRows: [] });
      expect(h.formatPlanTree(r.planNodes[0])).toContain('actual time');
    });
  });

  describe('getTableStats path branches', () => {
    it('uses stat collector when provided', () => {
      const collector = {
        getTableStats: (t: string) => ({ rowCount: 77 }),
        estimateSelectivity: () => 1.0,
      } as any;
      const h = new ExplainHandler(undefined, undefined, collector);
      const r = h.buildPlan('SELECT * FROM bigtable');
      expect(r.planNodes[0].planRows).toBe(77);
    });

    it('uses selectivity estimate from stat collector for non-PK equality', () => {
      const collector = {
        getTableStats: (t: string) => ({ rowCount: 100 }),
        estimateSelectivity: () => 0.5,
      } as any;
      const h = new ExplainHandler(undefined, undefined, collector);
      const r = h.buildPlan('SELECT * FROM bigtable WHERE name = \'x\'');
      expect(r.planNodes[0].planRows).toBe(50);
    });
  });

  describe('DDL variants', () => {
    it('builds create index / alter table / drop plans', () => {
      const h = makeHandler();
      expect(h.buildPlan('CREATE INDEX idx ON t (id)').planNodes[0].nodeType).toBe('Create Index');
      expect(h.buildPlan('ALTER TABLE t ADD c int').planNodes[0].nodeType).toBe('Alter Table');
      expect(h.buildPlan('DROP TABLE t').planNodes[0].nodeType).toBe('Drop Table');
    });

    it('inspects DDL relation name', () => {
      const h = makeHandler();
      expect(h.buildPlan('DROP TABLE users').planNodes[0].relationName).toBe('users');
    });

    it('handles DROP with multiple tables (names array)', () => {
      const h = makeHandler();
      expect(h.buildPlan('DROP TABLE a, b').planNodes[0].relationName).toBe('a');
    });

    it('falls back to unknown relation name for TRUNCATE', () => {
      const h = makeHandler();
      const r = h.buildPlan('TRUNCATE t');
      expect(r.planNodes[0].relationName).toBe('unknown');
    });
  });

  describe('explainNodeToJson / explainNodeToYaml property branches', () => {
    it('serializes a fully-attributed node to JSON', () => {
      const node = ExplainHandler.planNodeToExplainNode({
        nodeType: 'Index Scan',
        relationName: 'users',
        startupCost: 0,
        totalCost: 1,
        planRows: 1,
        planWidth: 32,
        indexName: 'users_pkey',
        indexCond: 'id = 1',
        filter: 'id = 1',
        sortKey: 'name DESC',
        strategy: 'HashAggregate',
        hashCond: 't1.id = t2.id',
        joinType: 'INNER',
        alias: 'u',
        actualStartupTime: 0.1,
        actualTotalTime: 0.5,
        actualRows: 1,
        actualLoops: 1,
        plans: [{ nodeType: 'Seq Scan', relationName: 'x', startupCost: 0, totalCost: 1, planRows: 10, planWidth: 32 }],
      });
      const json = ExplainHandler.explainNodeToJson(node);
      expect(json['Node Type']).toBe('Index Scan');
      expect(json['Index Name']).toBe('users_pkey');
      expect(json['Index Cond']).toBe('id = 1');
      expect(json['Filter']).toBe('id = 1');
      expect(json['Sort Key']).toBe('name DESC');
      expect(json['Strategy']).toBe('HashAggregate');
      expect(json['Hash Cond']).toBe('t1.id = t2.id');
      expect(json['Join Type']).toBe('INNER');
      expect(json['Alias']).toBe('u');
      expect(json['Actual Startup Time']).toBe(0.1);
      expect(json['Actual Total Time']).toBe(0.5);
      expect(json['Actual Rows']).toBe(1);
      expect(json['Actual Loops']).toBe(1);
      expect(json['Plans']).toHaveLength(1);
    });

    it('serializes a bare node to JSON (all optional fields absent)', () => {
      const bare: any = { NodeType: 'Seq Scan', StartupCost: 0, TotalCost: 1, PlanRows: 10, PlanWidth: 32 };
      const json = ExplainHandler.explainNodeToJson(bare);
      expect(json['Node Type']).toBe('Seq Scan');
      expect(json).not.toHaveProperty('Relation Name');
      expect(json).not.toHaveProperty('Filter');
      expect(json).not.toHaveProperty('Plans');
    });

    it('serializes a fully-attributed node to YAML lines', () => {
      const node = ExplainHandler.planNodeToExplainNode({
        nodeType: 'Seq Scan',
        relationName: 'users',
        startupCost: 0,
        totalCost: 1,
        planRows: 1,
        planWidth: 32,
        filter: 'x = 1',
        indexName: 'idx',
        indexCond: 'x = 1',
        sortKey: 'x',
        strategy: 'GroupAggregate',
        hashCond: 'a=b',
        joinType: 'LEFT',
        actualStartupTime: 0.1,
        actualTotalTime: 0.5,
        actualRows: 1,
        actualLoops: 1,
      });
      const lines = ExplainHandler.explainNodeToYaml(node);
      const joined = lines.join('\n');
      expect(joined).toContain('Node Type: Seq Scan');
      expect(joined).toContain('Relation Name: users');
      expect(joined).toContain('Filter: x = 1');
      expect(joined).toContain('Index Name: idx');
      expect(joined).toContain('Join Type: LEFT');
    });

    it('serializes a bare node to YAML (no optional fields)', () => {
      const bare: any = { NodeType: 'Seq Scan', StartupCost: 0, TotalCost: 1, PlanRows: 10, PlanWidth: 32 };
      const lines = ExplainHandler.explainNodeToYaml(bare);
      const joined = lines.join('\n');
      expect(joined).toContain('Node Type: Seq Scan');
      expect(joined).not.toContain('Filter:');
      expect(joined).not.toContain('Plans:');
    });

    it('serializes output columns in YAML', () => {
      const node: any = {
        NodeType: 'Seq Scan',
        StartupCost: 0,
        TotalCost: 1,
        PlanRows: 10,
        PlanWidth: 32,
        OutputColumns: ['id', 'name'],
      };
      const lines = ExplainHandler.explainNodeToYaml(node);
      expect(lines.join('\n')).toContain('Output Columns:');
    });

    it('serializes OneTimeFilter in JSON', () => {
      const node: any = {
        NodeType: 'Seq Scan',
        StartupCost: 0,
        TotalCost: 1,
        PlanRows: 10,
        PlanWidth: 32,
        OneTimeFilter: 'x = 1',
      };
      const json = ExplainHandler.explainNodeToJson(node);
      expect(json['One-Time Filter']).toBe('x = 1');
    });
  });

  describe('explainResultToRows / planNodeToJson', () => {
    it('returns JSON row for json output format', () => {
      const result: any = {
        outputFormat: 'json',
        planNodes: [{ nodeType: 'Seq Scan', startupCost: 0, totalCost: 1, planRows: 10, planWidth: 32 }],
        planningTime: 1,
        executionTime: 2,
      };
      const rows = ExplainHandler.explainResultToRows(result);
      expect(rows).toHaveLength(1);
      expect(rows[0]['QUERY PLAN']).toContain('Node Type');
    });

    it('planNodeToJson serializes actual and relation fields', () => {
      const json = ExplainHandler.planNodeToJson({
        nodeType: 'Seq Scan',
        relationName: 't',
        startupCost: 0,
        totalCost: 1,
        planRows: 10,
        planWidth: 32,
        filter: 'x=1',
        indexName: 'idx',
        indexCond: 'x=1',
        sortKey: 'x',
        strategy: 'HashAggregate',
        hashCond: 'a=b',
        joinType: 'INNER',
        alias: 'z',
        actualStartupTime: 0.1,
        actualTotalTime: 0.5,
        actualRows: 1,
        plans: [{ nodeType: 'Seq Scan', relationName: 'c', startupCost: 0, totalCost: 1, planRows: 1, planWidth: 32 }],
      });
      expect(json['Node Type']).toBe('Seq Scan');
      expect(json['Relation Name']).toBe('t');
      expect(json['Filter']).toBe('x=1');
      expect(json['Actual Rows']).toBe(1);
      expect(json['Plans']).toHaveLength(1);
    });

    it('planTreeToJson omits execution time and options when not given', () => {
      const json = ExplainHandler.planTreeToJson(
        { nodeType: 'Seq Scan', relationName: 't', startupCost: 0, totalCost: 1, planRows: 10, planWidth: 32 },
      );
      expect(json['Query Plan']['Node Type']).toBe('Seq Scan');
      expect(json).not.toHaveProperty('Execution Time');
      expect(json).not.toHaveProperty('Options');
    });

    it('formatExplainOutput renders a nested plan tree as text', () => {
      const h = new ExplainHandler({ format: 'text' });
      const node = h.buildExplainPlan('SELECT a,b FROM t1 JOIN t2 ON t1.id=t2.id');
      const out = h.formatExplainOutput(node);
      expect(out).toContain('Hash Join');
    });
  });

  describe('formatExplainOutput', () => {
    const node: any = {
      NodeType: 'Seq Scan',
      StartupCost: 0,
      TotalCost: 1,
      PlanRows: 10,
      PlanWidth: 32,
    };

    it('formats JSON', () => {
      const h = new ExplainHandler({ format: 'json' });
      const out = h.formatExplainOutput(node, 1.234, 5.678);
      const parsed = JSON.parse(out);
      expect(parsed['Query Plan']['Node Type']).toBe('Seq Scan');
      expect(parsed['Planning Time']).toBe(1.23);
      expect(parsed['Execution Time']).toBe(5.68);
    });

    it('formats YAML', () => {
      const h = new ExplainHandler({ format: 'yaml' });
      const out = h.formatExplainOutput(node, 1.234, 5.678);
      expect(out).toContain('Query Plan:');
      expect(out).toContain('Node Type: Seq Scan');
      expect(out).toContain('Planning Time: 1.23');
      expect(out).toContain('Execution Time: 5.68');
    });

    it('formats text (default) via plan tree', () => {
      const h = new ExplainHandler({ format: 'text' });
      const out = h.formatExplainOutput(node);
      expect(typeof out).toBe('string');
    });

    it('omits Planning/Execution time when not provided (json)', () => {
      const h = new ExplainHandler({ format: 'json' });
      const out = JSON.parse(h.formatExplainOutput(node));
      expect(out).not.toHaveProperty('Planning Time');
      expect(out).not.toHaveProperty('Execution Time');
    });

    it('omits Planning/Execution time when not provided (yaml)', () => {
      const h = new ExplainHandler({ format: 'yaml' });
      const out = h.formatExplainOutput(node);
      expect(out).not.toContain('Planning Time:');
      expect(out).not.toContain('Execution Time:');
    });

    it('builds text output from a real SQL plan', () => {
      const h = new ExplainHandler({ format: 'text' });
      const out = h.formatExplainOutput(h.buildExplainPlan('SELECT * FROM users WHERE id = 1'));
      expect(out).toContain('Index Scan');
    });
  });

  describe('detectAggregate', () => {
    it('handles COUNT(*), SUM, AVG, and bare refs', () => {
      const h = makeHandler();
      expect(h.buildPlan('SELECT count(*) FROM t GROUP BY a').planNodes[0].nodeType).toBe('Aggregate');
      expect(h.buildPlan('SELECT avg(x) FROM t GROUP BY a').planNodes[0].nodeType).toBe('Aggregate');
      expect(h.buildPlan('SELECT a, b FROM t GROUP BY a, b').planNodes[0].nodeType).toBe('Aggregate');
    });

    it('uses GroupAggregate strategy for plain GROUP BY without aggregate functions', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT a FROM t GROUP BY a');
      expect(r.planNodes[0].nodeType).toBe('Aggregate');
      expect(r.planNodes[0].strategy).toBe('GroupAggregate');
    });

    it('uses HashAggregate strategy for aggregate functions', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT count(*) FROM t GROUP BY a');
      expect(r.planNodes[0].strategy).toBe('HashAggregate');
    });

    it('does not aggregate a plain projection', () => {
      const h = makeHandler();
      expect(h.buildPlan('SELECT a, b FROM t').planNodes[0].nodeType).toBe('Seq Scan');
    });

    it('does not treat a non-aggregate function call as an aggregate', () => {
      const h = makeHandler();
      expect(h.buildPlan('SELECT lower(name) FROM t').planNodes[0].nodeType).toBe('Seq Scan');
    });
  });

  describe('JOIN without ON and ORDER BY without direction', () => {
    it('handles a cross join (no ON clause)', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM t1 CROSS JOIN t2');
      expect(r.planNodes[0].nodeType).toBe('Hash Join');
    });

    it('defaults ORDER BY direction to ASC when unspecified', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users ORDER BY name');
      expect(r.planNodes[0].sortKey).toContain('ASC');
    });
  });

  describe('with HAVING and GROUP BY', () => {
    it('builds an aggregate node with a filter for HAVING', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT count(*) FROM t GROUP BY a HAVING count(*) > 1');
      expect(r.planNodes[0].nodeType).toBe('Aggregate');
    });
  });

  describe('vector search detection', () => {
    it('detects VECTOR_DISTANCE', () => {
      const h = makeHandler();
      const r = h.buildPlan("SELECT * FROM t WHERE VECTOR_DISTANCE(emb, '[1,2]') < 0.5 LIMIT 5");
      expect(r.summary.hasVectorSearch).toBe(true);
    });

    it('builds a vector plan without a LIMIT (default 10) and default relation', () => {
      const h = makeHandler();
      const r = h.buildPlan("SELECT * FROM VEC_SEARCH('[1,2,3]')");
      expect(r.summary.hasVectorSearch).toBe(true);
    });
  });

  describe('LIMIT value extraction', () => {
    it('handles LIMIT with a bound expression fallback', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM t LIMIT 10');
      expect(r.planNodes[0].planRows).toBe(10);
    });
  });

  describe('equality detection edge cases', () => {
    it('falls back to Seq Scan for OR conditions', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users WHERE id = 1 OR id = 2');
      expect(r.planNodes[0].nodeType).toBe('Seq Scan');
    });

    it('falls back to Seq Scan for non-equality on PK', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users WHERE id > 1');
      expect(r.planNodes[0].nodeType).toBe('Seq Scan');
    });

    it('detects PK equality on a column named *_id', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users WHERE user_id = 1');
      expect(r.planNodes[0].nodeType).toBe('Index Scan');
    });

    it('falls back to Seq Scan for a non-binary WHERE (single ref)', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users WHERE active');
      expect(r.planNodes[0].nodeType).toBe('Seq Scan');
    });

    it('falls back to Seq Scan for a literal on the left of =', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM users WHERE 1 = id');
      expect(r.planNodes[0].nodeType).toBe('Seq Scan');
    });
  });

  describe('FROM-less and degenerate SELECTs', () => {
    it('builds an unknown scan for SELECT with no FROM', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT 1');
      expect(r.planNodes[0].nodeType).toBe('Seq Scan');
      expect(r.planNodes[0].relationName).toBe('unknown');
    });

    it('handles a subquery in the FROM clause', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT * FROM (SELECT 1) AS sub');
      expect(r.planNodes[0].nodeType).toBe('Seq Scan');
    });
  });

  describe('aggregate with join', () => {
    it('adds join cost to the aggregate node', () => {
      const h = makeHandler();
      const r = h.buildPlan('SELECT count(*) FROM t1 JOIN t2 ON t1.id = t2.id GROUP BY t1.a');
      expect(r.planNodes[0].nodeType).toBe('Aggregate');
    });
  });

  describe('DML without WHERE', () => {
    it('builds INSERT / UPDATE / DELETE plans without a filter', () => {
      const h = makeHandler();
      expect(h.buildPlan("INSERT INTO users (name) VALUES ('a')").planNodes[0].nodeType).toBe('Insert');
      expect(h.buildPlan('UPDATE users SET name = \'x\'').planNodes[0].nodeType).toBe('Update');
      expect(h.buildPlan('DELETE FROM users').planNodes[0].nodeType).toBe('Delete');
    });
  });

  describe('selectivity edge cases', () => {
    it('defaults selectivity to 1.0 for non-binary where', () => {
      const collector = {
        getTableStats: (t: string) => ({ rowCount: 100 }),
        estimateSelectivity: () => 0.25,
      } as any;
      const h = new ExplainHandler(undefined, undefined, collector);
      // A WHERE with a single ref (not binary) — e.g. boolean column
      const r = h.buildPlan('SELECT * FROM t WHERE active');
      expect(r.planNodes[0].planRows).toBeGreaterThan(0);
    });

    it('returns 1.0 selectivity when the binary left side is not a ref', () => {
      const collector = {
        getTableStats: (t: string) => ({ rowCount: 100 }),
        estimateSelectivity: () => 0.25,
      } as any;
      const h = new ExplainHandler(undefined, undefined, collector);
      // WHERE 1 = 1 — left side is an integer literal, not a ref column
      const r = h.buildPlan('SELECT * FROM t WHERE 1 = 1');
      expect(r.planNodes[0].planRows).toBe(100);
    });

    it('estimates selectivity via stat collector for a ref column', () => {
      const collector = {
        getTableStats: (t: string) => ({ rowCount: 80 }),
        estimateSelectivity: () => 0.125,
      } as any;
      const h = new ExplainHandler(undefined, undefined, collector);
      const r = h.buildPlan('SELECT * FROM t WHERE name = \'x\'');
      expect(r.planNodes[0].planRows).toBe(10);
    });
  });

  describe('getTableStats edge cases (safe table / catch)', () => {
    it('falls back to 1000 when the table name sanitizes to empty', () => {
      const db = new Database(':memory:');
      const h = new ExplainHandler(undefined, db);
      // A table name of pure punctuation sanitizes to '' → 1000 rows
      const r = h.buildPlan('SELECT * FROM "!!!"');
      expect(r.planNodes[0].planRows).toBe(1000);
      db.close();
    });

    it('falls back to 1000 when the table does not exist', () => {
      const db = new Database(':memory:');
      const h = new ExplainHandler(undefined, db);
      const r = h.buildPlan('SELECT * FROM nonexistent_table');
      expect(r.planNodes[0].planRows).toBe(1000);
      db.close();
    });
  });

  describe('stat collector returning null stats', () => {
    it('falls back to default rows when collector returns null', () => {
      const collector = {
        getTableStats: () => null,
        estimateSelectivity: () => 0.5,
      } as any;
      const h = new ExplainHandler(undefined, undefined, collector);
      const r = h.buildPlan('SELECT * FROM t');
      expect(r.planNodes[0].planRows).toBe(1000);
    });
  });
});
