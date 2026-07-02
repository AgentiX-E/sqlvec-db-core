/**
 * SecurityNoticeCollector — Thread-local notice accumulator for security shim rewrites.
 *
 * Security shims (MFA, SSH Key, OAuth2, Data Masking, Precompute, Encryption Policy)
 * silently rewrite SQL to `SELECT 1` when they detect unimplemented PG features.
 * This collector tracks which shims have fired so that the QueryRouter can add
 * NOTICE messages to the QueryResult that gets sent to the client.
 *
 * Usage:
 *   import { SecurityNoticeCollector } from './SecurityNoticeCollector';
 *
 *   // In shim:
 *   if (rewritten) {
 *     SecurityNoticeCollector.add('mfa', 'MFA is not implemented by this database vendor');
 *   }
 *
 *   // In QueryRouter.execute():
 *   const result = await this.executeInternal(...);
 *   SecurityNoticeCollector.drain().forEach(n => {
 *     result.notices = result.notices || [];
 *     result.notices.push(n);
 *   });
 *
 * @module query/SecurityNoticeCollector
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('SecurityNoticeCollector');

interface SecurityNotice {
  severity: string;
  message: string;
  detail?: string;
}

const noticeStore: SecurityNotice[] = [];

export class SecurityNoticeCollector {
  /**
   * Add a notice that a security feature was rewritten but not enforced.
   */
  static add(feature: string, message: string, detail?: string): void {
    noticeStore.push({
      severity: 'WARNING',
      message: `[${feature.toUpperCase()}] ${message}`,
      detail,
    });
    logger.warn({ feature, message }, 'Security shim NOTICE');
  }

  /**
   * Drain all accumulated notices and clear the store.
   * Returns an empty array if no notices exist.
   */
  static drain(): SecurityNotice[] {
    if (noticeStore.length === 0) return [];
    const copy = [...noticeStore];
    noticeStore.length = 0;
    return copy;
  }

  /**
   * Check the current notice count (without draining).
   */
  static get count(): number {
    return noticeStore.length;
  }

  /**
   * Clear all notices without draining.
   */
  static clear(): void {
    noticeStore.length = 0;
  }
}
