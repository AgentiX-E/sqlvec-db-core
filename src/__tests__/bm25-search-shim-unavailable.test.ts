import { describe, it, expect, vi, afterEach } from 'vitest';
import Module from 'node:module';
import { Bm25SearchShim } from '../query/Bm25SearchShim';

// Force the `require('natural')` call in the constructor to throw so the
// catch branch (available=false) is exercised. We stub the Node module
// loader's `require` for the `natural` package and restore it afterwards.
const proto = Module.prototype;
const originalRequire = proto.require;

describe('Bm25SearchShim (natural unavailable)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    proto.require = originalRequire;
  });

  it('reports unavailable and no-ops index/search', () => {
    proto.require = function (id: string) {
      if (id === 'natural') throw new Error('Cannot find module natural');
      return originalRequire.apply(this, arguments as any);
    } as any;

    const shim = new Bm25SearchShim();
    expect(shim.isAvailable()).toBe(false);

    shim.registerFtsConfig('docs', ['content']);
    shim.indexRow('docs', 1, { content: 'foo bar' });
    expect(shim.getDocumentCount()).toBe(0);

    const results = shim.search(
      { tableName: 'docs', matchColumn: 'content', keywords: 'foo', limit: 10 },
      [{ id: 1, content: 'foo bar' }],
      'id',
    );
    expect(results.length).toBe(0);
  });
});
