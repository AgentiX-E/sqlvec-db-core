import { describe, it, expect, beforeEach } from 'vitest';
import { SecurityNoticeCollector } from '../query/SecurityNoticeCollector';

// SecurityNoticeCollector accumulates NOTICE messages from security shims and
// lets the QueryRouter drain them onto the QueryResult. This locks the add/drain/
// clear/count contract.
describe('SecurityNoticeCollector', () => {
  beforeEach(() => {
    SecurityNoticeCollector.clear();
  });

  it('starts empty', () => {
    expect(SecurityNoticeCollector.count).toBe(0);
  });

  it('add stores a WARNING notice with uppercased feature and message prefix', () => {
    SecurityNoticeCollector.add('mfa', 'MFA is not implemented');
    expect(SecurityNoticeCollector.count).toBe(1);

    const [notice] = SecurityNoticeCollector.drain();
    expect(notice.severity).toBe('WARNING');
    expect(notice.message).toBe('[MFA] MFA is not implemented');
    expect(notice.detail).toBeUndefined();
  });

  it('add preserves an optional detail field', () => {
    SecurityNoticeCollector.add('oauth2', 'OAuth2 unavailable', 'token exchange skipped');
    const [notice] = SecurityNoticeCollector.drain();
    expect(notice.detail).toBe('token exchange skipped');
  });

  it('drain returns notices in insertion order and clears the store', () => {
    SecurityNoticeCollector.add('a', 'first');
    SecurityNoticeCollector.add('b', 'second');
    SecurityNoticeCollector.add('c', 'third');

    const drained = SecurityNoticeCollector.drain();
    expect(drained.map((n) => n.message)).toEqual(['[A] first', '[B] second', '[C] third']);
    expect(SecurityNoticeCollector.count).toBe(0);
  });

  it('drain on empty returns an empty array', () => {
    expect(SecurityNoticeCollector.drain()).toEqual([]);
  });

  it('clear empties without returning anything', () => {
    SecurityNoticeCollector.add('x', 'y');
    SecurityNoticeCollector.clear();
    expect(SecurityNoticeCollector.count).toBe(0);
  });

  it('drain returns a copy, so mutating it does not affect the internal store', () => {
    SecurityNoticeCollector.add('x', 'y');
    const drained = SecurityNoticeCollector.drain();
    drained.length = 0;
    // Store is already cleared by drain; re-adding and draining returns fresh data.
    SecurityNoticeCollector.add('z', 'w');
    expect(SecurityNoticeCollector.drain().map((n) => n.message)).toEqual(['[Z] w']);
  });
});
