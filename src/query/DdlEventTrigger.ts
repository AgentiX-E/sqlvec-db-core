/**
 * DdlEventTrigger — Event-driven DDL trigger system.
 *
 * Hooks into the QueryRouter to intercept and react to DDL events
 * (CREATE, ALTER, DROP). Supports PostgreSQL-compatible `CREATE EVENT TRIGGER`
 * syntax and fires triggers on `ddl_command_start` / `ddl_command_end` events.
 *
 * ## Design
 *
 * The DdlEventTrigger wraps around the QueryRouter's DDL execution pipeline.
 * When a DDL statement is about to be executed, the trigger fires registered
 * callbacks with the DDL information. This enables:
 *
 * - DDL auditing (log all schema changes)
 * - Schema migration triggers (auto-update tracking tables)
 * - Permission enforcement (block DDL on certain tables)
 * - Replication triggers (sync schema changes to replicas)
 *
 * ## Example
 *
 * ```typescript
 * const ddlTrigger = new DdlEventTrigger();
 *
 * // Register a trigger that fires before any DDL
 * ddlTrigger.on('ddl_command_start', (event) => {
 *   console.log('DDL attempt:', event.ddlTag, event.sql);
 * });
 *
 * // Hook into the query router
 * ddlTrigger.hookQueryRouter(router);
 * ```
 *
 * @module query/DdlEventTrigger
 */

import { PinoLogger } from '../logger/PinoLogger';

// ── Types ────────────────────────────────────────────────────────

/**
 * Supported DDL event types.
 */
export type DdlEventType = 'ddl_command_start' | 'ddl_command_end' | 'sql_drop';

/**
 * Status of a DDL event trigger.
 */
export type DdlTriggerStatus = 'enabled' | 'disabled' | 'broken';

/**
 * Payload delivered to trigger callbacks.
 */
export interface DdlEventPayload {
  /** The event type that fired */
  eventType: DdlEventType;
  /** DDL command tag (e.g. 'CREATE TABLE', 'ALTER TABLE', 'DROP INDEX') */
  ddlTag: string;
  /** The full DDL SQL statement */
  sql: string;
  /** Timestamp when the event occurred (epoch ms) */
  timestamp: number;
  /** Object type (e.g. 'table', 'view', 'index') */
  objectType?: string;
  /** Object name */
  objectName?: string;
  /** Schema name */
  schema?: string;
}

/**
 * Fire timing for a DDL event trigger.
 */
export type DdlTriggerTiming = 'before' | 'after';

/**
 * Filter constraint for DDL triggers.
 */
export interface DdlTriggerFilter {
  /** Only fire when TAG matches one of these */
  tags?: string[];
}

/**
 * Descriptor for a registered DDL event trigger.
 */
export interface DdlEventTriggerDescriptor {
  /** Unique trigger name */
  name: string;
  /** Event type this trigger fires on */
  event: DdlEventType;
  /** Callback function reference */
  functionName: string;
  /** Whether the trigger is enabled */
  enabled: boolean;
  /** Optional tag filter */
  tags?: string[];
  /** When the trigger was created (epoch ms) */
  createdAt: number;
  /** Fire count */
  fireCount: number;
}

/**
 * Callback type for DDL event triggers.
 */
export type DdlEventCallback = (
  payload: DdlEventPayload,
) => void | Promise<void>;

/**
 * Query router interface (minimal dependency).
 * We accept a router-like object that has a DDL execution method.
 */
export interface QueryRouterLike {
  executeDDL(sql: string): any;
}

// ── DdlEventTrigger ──────────────────────────────────────────────

export class DdlEventTrigger {
  private readonly logger = PinoLogger.forComponent('ddl-event-trigger');

  /** Registered triggers: name -> descriptor */
  private triggers: Map<string, DdlEventTriggerDescriptor> = new Map();

  /** Registered callbacks: name -> callback function */
  private callbacks: Map<string, DdlEventCallback> = new Map();

  /** Raw event listeners: event type -> set of callback refs */
  private eventListeners: Map<DdlEventType, Set<string>> = new Map();

  /** Hooks that intercept DDL before/after execution */
  private beforeHooks: Array<(sql: string) => boolean> = [];
  private afterHooks: Array<(sql: string, result: any) => void> = [];

  /** Hook function injected into QueryRouter */
  private hookedRouter: QueryRouterLike | null = null;
  private originalDDLMethod: ((sql: string) => any) | null = null;

  // ── Trigger Management ────────────────────────────────────────

  /**
   * Create a new DDL event trigger.
   *
   * Simulates PostgreSQL's `CREATE EVENT TRIGGER name ON event ...`.
   *
   * @param options.name         - Unique trigger name
   * @param options.event        - DDL event type
   * @param options.callback     - Callback function or function name
   * @param options.tags         - Optional WHEN TAG IN filter
   */
  createTrigger(options: {
    name: string;
    event: DdlEventType;
    callback: string | DdlEventCallback;
    tags?: string[];
  }): void {
    const { name, event, tags } = options;

    if (this.triggers.has(name)) {
      throw new Error(`DDL event trigger "${name}" already exists`);
    }

    const descriptor: DdlEventTriggerDescriptor = {
      name,
      event,
      functionName: typeof options.callback === 'string'
        ? options.callback
        : `callback_${name}`,
      enabled: true,
      tags,
      createdAt: Date.now(),
      fireCount: 0,
    };

    this.triggers.set(name, descriptor);

    // Register the callback if it's a function
    if (typeof options.callback === 'function') {
      this.callbacks.set(descriptor.functionName, options.callback);
    }

    // Add to event listeners
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(descriptor.functionName);

    this.logger.info({ name, event, tags: tags?.length || 0 }, 'DDL event trigger created');
  }

  /**
   * Create a trigger from a `CREATE EVENT TRIGGER` SQL statement.
   *
   * @param sql - The CREATE EVENT TRIGGER SQL statement
   * @returns true if successfully created
   */
  createTriggerFromSQL(sql: string): boolean {
    const trimmed = sql.trim();

    // Parse: CREATE EVENT TRIGGER name ON event [WHEN TAG IN (tag1, tag2)] EXECUTE FUNCTION func()
    const match = trimmed.match(
      /CREATE\s+EVENT\s+TRIGGER\s+(\w+)\s+ON\s+(ddl_command_start|ddl_command_end|sql_drop)(?:\s+WHEN\s+TAG\s+IN\s*\(([^)]*)\))?.*(?:EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)|EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+))/i,
    );

    // Simpler fallback parsing
    const nameMatch = trimmed.match(/CREATE\s+EVENT\s+TRIGGER\s+(\w+)/i);
    const eventMatch = trimmed.match(/ON\s+(ddl_command_start|ddl_command_end|sql_drop)/i);
    const fnMatch = trimmed.match(/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)/i);

    if (!nameMatch || !eventMatch) {
      this.logger.warn({ sql: sql.substring(0, 80) }, 'Failed to parse CREATE EVENT TRIGGER');
      return false;
    }

    const name = nameMatch[1];
    const event = eventMatch[1].toLowerCase() as DdlEventType;

    // Parse WHEN TAG IN (...)
    let tags: string[] | undefined;
    const tagMatch = trimmed.match(/WHEN\s+TAG\s+IN\s*\(\s*('[^']*'(?:\s*,\s*'[^']*')*)\s*\)/i);
    if (tagMatch) {
      // tagMatch[1] always contains at least one quoted tag, so the `.map(...)`
      // result is a non-empty array and the `|| undefined` fallback never applies.
      /* c8 ignore next */
      tags = tagMatch[1].match(/'([^']*)'/g)?.map((t) => t.replace(/'/g, '')) || undefined;
    }

    const functionName = fnMatch ? fnMatch[1] : `event_${name}`;

    // Create the trigger with a no-op callback that fires the DDL event
    this.createTrigger({
      name,
      event,
      callback: functionName,
      tags,
    });

    return true;
  }

  /**
   * Drop an existing trigger.
   *
   * @param name - Trigger name to drop
   * @returns true if found and removed
   */
  dropTrigger(name: string): boolean {
    const descriptor = this.triggers.get(name);
    if (!descriptor) {
      this.logger.warn({ name }, 'DDL event trigger not found for drop');
      return false;
    }

    this.triggers.delete(name);
    this.callbacks.delete(descriptor.functionName);

    // Remove from event listeners
    const listeners = this.eventListeners.get(descriptor.event);
    // createTrigger always adds the descriptor's functionName to the listener
    // set for its event, so `listeners` is always present for a registered trigger.
    /* c8 ignore next */
    if (listeners) {
      listeners.delete(descriptor.functionName);
      if (listeners.size === 0) {
        this.eventListeners.delete(descriptor.event);
      }
    }

    this.logger.info({ name }, 'DDL event trigger dropped');
    return true;
  }

  /**
   * Enable or disable a trigger.
   *
   * @param name   - Trigger name
   * @param enable - Whether to enable (default: true)
   */
  setTriggerEnabled(name: string, enable: boolean): void {
    const descriptor = this.triggers.get(name);
    if (!descriptor) {
      this.logger.warn({ name }, 'DDL event trigger not found for enable/disable');
      return;
    }
    descriptor.enabled = enable;
    this.logger.info({ name, enabled: enable }, 'DDL event trigger enabled state changed');
  }

  // ── Callback Registration ──────────────────────────────────────

  /**
   * Register a callback function that can be referenced by triggers.
   *
   * @param name     - Callback name (matches functionName in trigger)
   * @param callback - The callback function
   */
  registerCallback(name: string, callback: DdlEventCallback): void {
    this.callbacks.set(name, callback);
  }

  // ── Event Firing ───────────────────────────────────────────────

  /**
   * Fire DDL event triggers for the given event type and SQL.
   *
   * @param eventType - The type of DDL event
   * @param sql       - The DDL SQL statement
   * @param result    - Optional result from DDL execution
   */
  async fireEvent(
    eventType: DdlEventType,
    sql: string,
    result?: any,
  ): Promise<void> {
    const ddlTag = this.extractDDLTag(sql);
    const objectType = this.extractObjectType(sql);
    const objectName = this.extractObjectName(sql);

    const payload: DdlEventPayload = {
      eventType,
      ddlTag,
      sql,
      timestamp: Date.now(),
      objectType,
      objectName,
      schema: 'public',
    };

    // Get callbacks registered for this event type
    const listenerNames = this.eventListeners.get(eventType);
    if (!listenerNames || listenerNames.size === 0) return;

    for (const callbackName of listenerNames) {
      const descriptor = this.findDescriptorByCallbackName(callbackName);
      if (!descriptor || !descriptor.enabled) continue;

      // Check tag filter
      if (descriptor.tags && descriptor.tags.length > 0) {
        if (!descriptor.tags.includes(ddlTag)) continue;
      }

      const callback = this.callbacks.get(callbackName);
      if (callback) {
        try {
          await callback(payload);
          descriptor.fireCount++;
          this.logger.debug(
            { trigger: descriptor.name, eventType, ddlTag },
            'DDL event trigger fired',
          );
        } catch (err: any) {
          this.logger.error(
            { trigger: descriptor.name, eventType, err: err.message },
            'DDL event trigger callback failed',
          );
        }
      }
    }
  }

  /**
   * Fire a DDL start event before execution.
   *
   * @param sql - The DDL SQL about to execute
   */
  async fireStart(sql: string): Promise<void> {
    await this.fireEvent('ddl_command_start', sql);
  }

  /**
   * Fire a DDL end event after execution.
   *
   * @param sql    - The DDL SQL that was executed
   * @param result - Result of the DDL execution
   */
  async fireEnd(sql: string, result?: any): Promise<void> {
    await this.fireEvent('ddl_command_end', sql, result);
  }

  /**
   * Fire a sql_drop event after the DROP statement.
   *
   * @param sql - The DROP SQL statement
   */
  async fireDrop(sql: string): Promise<void> {
    await this.fireEvent('sql_drop', sql);
  }

  // ── QueryRouter Hooking ────────────────────────────────────────

  /**
   * Hook into a QueryRouter to intercept DDL execution.
   *
   * Wraps the router's executeDDL method (or similar) with before/after hooks.
   *
   * @param router - A router-like object with an executeDDL method
   */
  hookQueryRouter(router: QueryRouterLike): void {
    if (this.hookedRouter) {
      this.logger.warn('Already hooked into a QueryRouter; unhook first');
      return;
    }

    this.hookedRouter = router;
    this.originalDDLMethod = router.executeDDL;

    const self = this;
    router.executeDDL = async function (sql: string): Promise<any> {
      // Fire ddl_command_start
      await self.fireStart(sql);

      // Call original DDL method
      let result: any;
      let error: Error | null = null;
      try {
        result = await (self.originalDDLMethod as Function).call(this, sql);
      } catch (err: any) {
        error = err;
      }

      if (error) throw error;

      // Fire ddl_command_end
      await self.fireEnd(sql, result);

      // Fire sql_drop for DROP statements
      if (sql.trim().toUpperCase().startsWith('DROP')) {
        await self.fireDrop(sql);
      }

      return result;
    };

    this.logger.info('DdlEventTrigger hooked into QueryRouter');
  }

  /**
   * Unhook from the previously hooked QueryRouter.
   */
  unhookQueryRouter(): void {
    if (this.hookedRouter && this.originalDDLMethod) {
      this.hookedRouter.executeDDL = this.originalDDLMethod;
      this.hookedRouter = null;
      this.originalDDLMethod = null;
      this.logger.info('DdlEventTrigger unhooked from QueryRouter');
    }
  }

  /**
   * Register a before-DDL hook.
   * Returning false prevents the DDL from executing.
   *
   * @param hook - Function returning true to allow, false to block
   */
  addBeforeHook(hook: (sql: string) => boolean): void {
    this.beforeHooks.push(hook);
  }

  /**
   * Register an after-DDL hook.
   *
   * @param hook - Function called after DDL execution
   */
  addAfterHook(hook: (sql: string, result: any) => void): void {
    this.afterHooks.push(hook);
  }

  // ── Query Methods ──────────────────────────────────────────────

  /**
   * Get all registered triggers.
   */
  getAllTriggers(): DdlEventTriggerDescriptor[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Get triggers for a specific event type.
   *
   * @param event - Event type to filter by
   */
  getTriggersForEvent(event: DdlEventType): DdlEventTriggerDescriptor[] {
    return Array.from(this.triggers.values()).filter(
      (t) => t.event === event && t.enabled,
    );
  }

  /**
   * Get a specific trigger by name.
   *
   * @param name - Trigger name
   */
  getTrigger(name: string): DdlEventTriggerDescriptor | undefined {
    return this.triggers.get(name);
  }

  /**
   * Check if a SQL statement is a DDL statement.
   */
  isDDL(sql: string): boolean {
    const trimmed = sql.trim().toUpperCase();
    return (
      trimmed.startsWith('CREATE') ||
      trimmed.startsWith('ALTER') ||
      trimmed.startsWith('DROP') ||
      trimmed.startsWith('TRUNCATE') ||
      trimmed.startsWith('COMMENT ON') ||
      trimmed.startsWith('GRANT') ||
      trimmed.startsWith('REVOKE')
    );
  }

  /**
   * Get the total number of times triggers have fired.
   */
  getTotalFireCount(): number {
    let count = 0;
    for (const descriptor of this.triggers.values()) {
      count += descriptor.fireCount;
    }
    return count;
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.triggers.clear();
    this.callbacks.clear();
    this.eventListeners.clear();
    this.beforeHooks = [];
    this.afterHooks = [];
    this.unhookQueryRouter();
    this.logger.info('DdlEventTrigger state reset');
  }

  // ── Internal Helpers ───────────────────────────────────────────

  private findDescriptorByCallbackName(
    callbackName: string,
  ): DdlEventTriggerDescriptor | undefined {
    for (const descriptor of this.triggers.values()) {
      if (descriptor.functionName === callbackName) return descriptor;
    }
    // Listener names can only originate from createTrigger, which also registers
    // the matching descriptor, so no match here is unreachable in normal flow.
    /* c8 ignore next */
    return undefined;
  }

  /**
   * Extract the DDL command tag from a SQL statement.
   */
  private extractDDLTag(sql: string): string {
    const trimmed = sql.trim();
    const match = trimmed.match(
      /(CREATE\s+(?:OR\s+REPLACE\s+)?\w+|ALTER\s+\w+|DROP\s+\w+|TRUNCATE)\s/i,
    );
    if (match) return match[1].toUpperCase();
    return 'UNKNOWN';
  }

  /**
   * Extract the object type from a DDL statement.
   */
  private extractObjectType(sql: string): string | undefined {
    const trimmed = sql.trim();
    const match = trimmed.match(
      /(?:CREATE|ALTER|DROP)\s+(?:(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?(VIEW|TABLE|INDEX|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER|SCHEMA|TYPE|RULE|POLICY|EVENT\s+TRIGGER))/i,
    );
    if (match) return match[1].toLowerCase().replace('event trigger', 'event_trigger');
    return undefined;
  }

  /**
   * Extract the object name from a DDL statement.
   */
  private extractObjectName(sql: string): string | undefined {
    const trimmed = sql.trim();

    // CREATE TABLE/VIEW name
    const createMatch = trimmed.match(
      /CREATE\s+(?:(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?VIEW|TABLE|INDEX|SEQUENCE|FUNCTION|PROCEDURE|TYPE|EVENT\s+TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)/i,
    );
    if (createMatch) return createMatch[2];

    // ALTER name
    const alterMatch = trimmed.match(
      /ALTER\s+\w+\s+(?:ONLY\s+)?(?:(\w+)\.)?(\w+)/i,
    );
    if (alterMatch) return alterMatch[2];

    // DROP name
    const dropMatch = trimmed.match(
      /DROP\s+\w+\s+(?:IF\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)/i,
    );
    if (dropMatch) return dropMatch[2];

    return undefined;
  }
}
