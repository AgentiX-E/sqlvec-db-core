import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// parseExecute's outer regex `\(([^)]*)\)` stops at the first ')', so the
// paramsStr passed to parseParamValues never contains '(' or ')'. The
// depth-tracking branches in parseParamValues are therefore unreachable in
// practice. Cover the reachable paths only.
describe('SqlParser parseParamValues reachable paths', () => {
  it('EXECUTE with numeric and string args parses types', () => {
    const r = parseStatement("EXECUTE f(42, 'x')") as any;
    expect(r.params).toEqual([42, 'x']);
  });

  it('EXECUTE with decimal and negative number', () => {
    const r = parseStatement('EXECUTE f(-1.5, 0)') as any;
    expect(r.params).toEqual([-1.5, 0]);
  });
});
