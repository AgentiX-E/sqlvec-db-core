/**
 * DDLTriggerManager — DDL event trigger management.
 *
 * Implements PostgreSQL-compatible DDL event triggers. When the QueryRouter
 * executes a DDL statement (CREATE, ALTER, DROP, etc.), the trigger manager
 * fires registered callbacks before and/or after execution.
 *
 * ## Event types
 *
 * - `ddl_command_start` — Fired before a DDL statement is executed.
 * - `ddl_command_end`   — Fired after a DDL statement is executed.
 * - `sql_drop`          — Fired after DROP statements, carrying dropped object info.
 *
 * ## Tag filtering
 *
 * Supports `WHEN TAG IN ('CREATE TABLE', 'CREATE VIEW')` syntax to constrain
 * triggers to specific DDL command tags.
 *
 * ## Utility pseudo-functions
 *
 * - `pg_event_trigger_ddl_commands()` — Returns DDL command info (tag, object type, identity).
 * - `pg_event_trigger_dropped_objects()` — Returns dropped object info (type, schema, name).
 *   Valid only within `sql_drop` event trigger callbacks.
 *
 * ## Example
 *
 * ```
 * const ddlMgr = new DDLTriggerManager();
 * ddlMgr.createTrigger('audit_ddl', 'ddl_command_start', (sql) => {
 *   this.logger.info({ sql }, 'DDL attempt');
 * });
 *
 * // With tag filtering:
 * ddlMgr.createTrigger('audit_create_table', 'ddl_command_end', (sql) => {
 *   this.logger.info({ sql }, 'CREATE TABLE executed');
 * }, ['CREATE TABLE']);
 *
 * // sql_drop with dropped objects via pseudo-function:
 * ddlMgr.createTrigger('audit_drop', 'sql_drop', (sql) => {
 *   const objs = ddlMgr.pgEventTriggerDroppedObjects();
 *   this.logger.info({ sql, objs }, 'DROP executed');
 * });
 * ```
 *
 * @module query/DDLTriggerManager
 */

import { PinoLogger } from '../logger/PinoLogger';

// ── Logger ───────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────

/**
 * DDL trigger event types.
 * - `ddl_command_start` — before DDL execution
 * - `ddl_command_end`   — after DDL execution
 * - `sql_drop`          — after DROP execution (PG-compatible)
 */
export type DDLTriggerEvent = 'ddl_command_start' | 'ddl_command_end' | 'sql_drop';

/**
 * Internal DDL trigger descriptor.
 */
export interface DDLTrigger {
  /** Unique trigger name. */
  name: string;
  /** Event that fires this trigger. */
  event: DDLTriggerEvent;
  /** Callback function or expression to evaluate. */
  callback: string;
  /** Whether to fire this trigger before or after the event. */
  timing: 'before' | 'after';
  /** Whether this trigger is enabled. */
  enabled: boolean;
  /** WHEN TAG IN (...) filter — only fire if DDL command tag matches. */
  tags?: string[];
}

/**
 * PG-compatible event trigger configuration (exposed via system catalogs).
 * Maps to PG's `pg_event_trigger` catalog columns.
 */
export interface EventTriggerConfig {
  /** Unique trigger name. */
  name: string;
  /** Event that fires this trigger. */
  event: DDLTriggerEvent;
  /** WHEN TAG IN filter list. */
  tags?: string[];
  /** Referenced function name. */
  functionName: string;
  /** Whether this trigger is enabled. */
  enabled: boolean;
}

/**
 * Describes a dropped object for `sql_drop` event handling.
 */
export interface DroppedObject {
  /** Object type (e.g., 'table', 'view', 'index', 'sequence', 'schema'). */
  type: string;
  /** Schema name (default: 'public'). */
  schema: string;
  /** Object name. */
  name: string;
  /** Original name before rename (if applicable). */
  originalName?: string;
}

/**
 * DDL command information returned by `pg_event_trigger_ddl_commands()`.
 */
export interface DDLCommandInfo {
  /** DDL command tag (e.g., 'CREATE TABLE', 'DROP TABLE'). */
  ddlTag: string;
  /** Object type (e.g., 'table', 'view'). */
  objectType: string;
  /** Schema name. */
  schema: string;
  /** Object identity (full qualified name). */
  identity: string;
  /** Whether part of an extension. */
  inExtension: boolean;
}

/**
 * Callback signature for DDL triggers (all event types).
 *
 * For `sql_drop` events, use `pgEventTriggerDroppedObjects()` within
 * the callback to access dropped object info.
 */
export type DDLTriggerCallback = (sql: string, event: DDLTriggerEvent) => void;

/**
 * Information about a newly created object extracted from a CREATE DDL statement.
 */
export interface CreatedObjectInfo {
  /** Object type: TABLE, VIEW, SEQUENCE, FUNCTION, INDEX */
  objectType: string;
  /** Object name (without schema prefix) */
  objectName: string;
  /** Schema name, or null for default */
  schemaName: string | null;
}

// ── DDL command patterns ────────────────────────────────────────

const DDL_PATTERNS = [
  /^\s*CREATE\s/i,
  /^\s*ALTER\s/i,
  /^\s*DROP\s/i,
  /^\s*TRUNCATE\s/i,
  /^\s*COMMENT\s/i,
  /^\s*GRANT\s/i,
  /^\s*REVOKE\s/i,
  /^\s*RENAME\s/i,
  /^\s*SECURITY\s/i,
  /^\s*ANALYZE\s/i,
  /^\s*VACUUM\s/i,
];

const DROP_PATTERNS = [
  /^\s*DROP\s/i,
];

/** Map of DDL command tag to object type for tag extraction. */
const DDL_TAG_MAP: Record<string, string> = {
  'CREATE TABLE': 'table',
  'ALTER TABLE': 'table',
  'DROP TABLE': 'table',
  'CREATE VIEW': 'view',
  'ALTER VIEW': 'view',
  'DROP VIEW': 'view',
  'CREATE INDEX': 'index',
  'ALTER INDEX': 'index',
  'DROP INDEX': 'index',
  'CREATE SEQUENCE': 'sequence',
  'ALTER SEQUENCE': 'sequence',
  'DROP SEQUENCE': 'sequence',
  'CREATE SCHEMA': 'schema',
  'ALTER SCHEMA': 'schema',
  'DROP SCHEMA': 'schema',
  'TRUNCATE': 'table',
  'CREATE FUNCTION': 'function',
  'ALTER FUNCTION': 'function',
  'DROP FUNCTION': 'function',
  'CREATE TRIGGER': 'trigger',
  'ALTER TRIGGER': 'trigger',
  'DROP TRIGGER': 'trigger',
  'CREATE EVENT TRIGGER': 'event_trigger',
  'ALTER EVENT TRIGGER': 'event_trigger',
  'DROP EVENT TRIGGER': 'event_trigger',
  'CREATE TABLE AS': 'table',
  'RENAME': 'table',
  'COMMENT': 'table',
  'GRANT': 'table',
  'REVOKE': 'table',
  'SECURITY': 'table',
  'ANALYZE': 'table',
  'VACUUM': 'table',
};

/**
 * Regex to extract object type and name from CREATE statements.
 * Handles: CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE FUNCTION,
 *          CREATE INDEX, CREATE OR REPLACE, CREATE TEMP/TEMPORARY, etc.
 *
 * Groups:
 *   1 - object type (TABLE, VIEW, SEQUENCE, etc.)
 *   2 - optional schema-qualified prefix (e.g. "myschema.")
 *   3 - object name (after schema prefix, if any)
 */
const CREATE_OBJECT_RE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?(TABLE|VIEW|SEQUENCE|INDEX|FUNCTION|PROCEDURE|TYPE)\s+(?:(?:IF\s+NOT\s+EXISTS\s+)?)?(?:(\w+)\.)?(\w+)/i;

// ── SQL parsing utilities ───────────────────────────────────────

/**
 * Extract the DDL command tag from a SQL statement.
 * Examples: 'CREATE TABLE', 'DROP TABLE', 'ALTER TABLE ... ADD'.
 *
 * @param sql - SQL statement.
 * @returns The DDL command tag (uppercase).
 */
export function extractDDLTag(sql: string): string {
  const trimmed = sql.trim();
  const match = trimmed.match(/^\s*(CREATE\s+(OR\s+REPLACE\s+)?|ALTER\s+|DROP\s+|TRUNCATE\s+|COMMENT\s+|GRANT\s+|REVOKE\s+|RENAME\s+|SECURITY\s+|ANALYZE\s+|VACUUM\s+)/i);
  if (!match) return 'UNKNOWN';

  const prefix = match[1].trim().toUpperCase();

  // Normalize `CREATE OR REPLACE` to `CREATE` — OR REPLACE is a modifier, not
  // part of the DDL command tag (the catalog maps `CREATE VIEW`, not
  // `CREATE OR REPLACE VIEW`).
  const normalizedPrefix = prefix.replace(/^CREATE\s+OR\s+REPLACE/, 'CREATE');

  // Single-keyword commands (TRUNCATE, COMMENT, GRANT, REVOKE, RENAME,
  // SECURITY, ANALYZE, VACUUM) carry their own tag; the word that follows is
  // an object name, not an object type. Only CREATE/ALTER/DROP take a `<cmd>
  // <objtype>` tag.
  if (
    normalizedPrefix !== 'CREATE' &&
    normalizedPrefix !== 'ALTER' &&
    normalizedPrefix !== 'DROP' &&
    !normalizedPrefix.startsWith('CREATE ')
  ) {
    return normalizedPrefix;
  }

  // Extract the object type (second word)
  const rest = trimmed.slice(match[0].length).trim();
  const objectTypeMatch = rest.match(/^(\w+)/);
  // The prefix regex already requires a trailing `\s+`, which is stripped by the
  // outer `trim()`, so `rest` always begins with a word char for a matched DDL
  // command; `objectTypeMatch` is never null here.
  /* c8 ignore next */
  if (!objectTypeMatch) return normalizedPrefix;

  const objectType = objectTypeMatch[1].toUpperCase();

  // Check for multi-word patterns like "CREATE TABLE AS"
  if (normalizedPrefix.startsWith('CREATE')) {
    // Check for CREATE TABLE AS / CREATE VIEW AS (no explicit table name)
    const restAfterType = rest.slice(objectTypeMatch[0].length).trim();
    if (/^AS\s/i.test(restAfterType)) {
      return `CREATE ${objectType} AS`;
    }
  }

  return `${normalizedPrefix} ${objectType}`;
}

/**
 * Parse a `WHEN TAG IN ('tag1', 'tag2')` clause from a SQL statement.
 *
 * @param sql - SQL containing an optional WHEN TAG IN clause.
 * @returns Array of tag strings, or undefined if not present.
 */
export function parseTagFilter(sql: string): string[] | undefined {
  const match = sql.match(/WHEN\s+TAG\s+IN\s*\(\s*('(?:[^']*)'(\s*,\s*'(?:[^']*)')*)\s*\)/i);
  if (!match) return undefined;

  // Extract individual quoted tags
  const tagMatches = match[1].match(/'([^']*)'/g);
  // The WHEN TAG IN pattern requires at least one quoted tag, so `match[1]`
  // always contains a quoted string and `tagMatches` is never null.
  /* c8 ignore next */
  if (!tagMatches) return undefined;

  return tagMatches.map((t) => t.replace(/'/g, '').trim().toUpperCase());
}

/**
 * Parse a `CREATE EVENT TRIGGER ... ON event WHEN TAG IN (...)` statement
 * and return the parsed config, or null if not parseable.
 *
 * @param sql - The CREATE EVENT TRIGGER SQL statement.
 * @returns Parsed EventTriggerConfig, or null.
 */
export function parseCreateEventTrigger(sql: string): EventTriggerConfig | null {
  const trimmed = sql.trim();

  // Match: CREATE EVENT TRIGGER name ON event [WHEN TAG IN (...)]
  const match = trimmed.match(
    /CREATE\s+EVENT\s+TRIGGER\s+(\w+)\s+ON\s+(ddl_command_start|ddl_command_end|sql_drop)/i,
  );
  if (!match) return null;

  const name = match[1];
  const event = match[2].toLowerCase() as DDLTriggerEvent;
  const tags = parseTagFilter(trimmed);

  // Extract function name from EXECUTE PROCEDURE / EXECUTE FUNCTION clause
  const fnMatch = trimmed.match(/EXECUTE\s+(PROCEDURE|FUNCTION)\s+(\w+)/i);
  const functionName = fnMatch ? fnMatch[2] : `event_${name}`;

  return { name, event, tags, functionName, enabled: true };
}

/**
 * Check if a SQL statement is a DROP statement (for sql_drop detection).
 *
 * @param sql - SQL statement.
 * @returns true if the statement starts with DROP.
 */
export function isDropStatement(sql: string): boolean {
  return DROP_PATTERNS.some((p) => p.test(sql.trim()));
}

/**
 * Extract potential dropped object type from a DROP statement.
 *
 * @param sql - DROP SQL statement.
 * @returns Object type (lowercase), or 'object' if unknown.
 */
export function extractDropObjectType(sql: string): string {
  const trimmed = sql.trim();
  const match = trimmed.match(/^\s*DROP\s+(TABLE|VIEW|INDEX|SEQUENCE|SCHEMA|FUNCTION|TRIGGER|EVENT\s+TRIGGER|RULE|POLICY|MATERIALIZED\s+VIEW|FOREIGN\s+TABLE)\s/i);
  if (!match) return 'object';

  let raw = match[1].trim().toLowerCase();
  // Normalize multi-word types
  if (raw === 'event trigger') raw = 'event_trigger';
  else if (raw === 'materialized view') raw = 'materialized_view';
  else if (raw === 'foreign table') raw = 'foreign_table';

  return raw;
}

/**
 * Extract object name from a DROP statement.
 *
 * @param sql - DROP SQL statement.
 * @returns Object name, or empty string if not found.
 */
export function extractDropObjectName(sql: string): string {
  const trimmed = sql.trim();
  // Drop the DROP TYPE prefix
  const match = trimmed.match(/^\s*DROP\s+(TABLE|VIEW|INDEX|SEQUENCE|SCHEMA|FUNCTION|TRIGGER|EVENT\s+TRIGGER|RULE|POLICY|MATERIALIZED\s+VIEW|FOREIGN\s+TABLE)\s+(?:IF\s+EXISTS\s+)?([\w.]+)/i);
  if (!match) return '';
  return match[2];
}

/**
 * Extract schema-qualified object names from a DROP statement.
 *
 * @param sql - DROP SQL statement.
 * @returns Array of {schema, name} objects.
 */
export function extractDropTargets(sql: string): Array<{ schema: string; name: string }> {
  const trimmed = sql.trim();
  const typeMatch = trimmed.match(/^\s*DROP\s+(TABLE|VIEW|INDEX|SEQUENCE|SCHEMA|FUNCTION|TRIGGER|EVENT\s+TRIGGER)\s+(?:IF\s+EXISTS\s+)?/i);
  if (!typeMatch) return [{ schema: 'public', name: 'unknown' }];

  const afterType = trimmed.slice(typeMatch[0].length).trim();
  // Split by comma for multi-object DROP
  const parts = afterType.split(/\s*,\s*/).map((p) => p.replace(/[();\s]+$/, '').trim()).filter(Boolean);

  // A matched type prefix (`DROP TYPE\s+`) guarantees at least one trailing
  // word char survives `trim()`, so `parts` is never empty here.
  /* c8 ignore next */
  if (parts.length === 0) return [{ schema: 'public', name: 'unknown' }];

  return parts.map((part) => {
    // Handle schema-qualified names (schema.name)
    const parts2 = part.split('.');
    if (parts2.length >= 2) {
      return { schema: parts2[0], name: parts2.slice(1).join('.') };
    }
    return { schema: 'public', name: part };
  });
}

// ── DDLTriggerManager ────────────────────────────────────────────

export class DDLTriggerManager {
  private readonly logger = PinoLogger.forComponent('ddltriggermanager');

  private triggers: Map<string, DDLTrigger> = new Map();
  private callbacks: Map<string, DDLTriggerCallback> = new Map();

  /**
   * Transient state: dropped objects captured BEFORE DROP execution.
   * Available through pg_event_trigger_dropped_objects() during sql_drop callbacks.
   */
  private transientDroppedObjects: DroppedObject[] = [];

  /**
   * Transient state: current DDL command info for this operation.
   * Available through pg_event_trigger_ddl_commands() during callbacks.
   */
  private transientDDLCommand: DDLCommandInfo | null = null;

  /**
   * Optional callback for auto-applying default privileges after DDL creation.
   * Invoked with (objectType, schemaName, objectName) after a CREATE statement.
   */
  private defaultPrivilegeApplier?: (objectType: string, schemaName: string | null, objectName: string) => void;

  /**
   * Create a new DDL trigger.
   *
   * @param name     - Unique trigger name.
   * @param event    - DDL event type ('ddl_command_start', 'ddl_command_end', or 'sql_drop').
   * @param callback - Callback identifier, function body string, or callback function.
   * @param tags     - Optional WHEN TAG IN filter array.
   */
  createTrigger(
    name: string,
    event: DDLTriggerEvent,
    callback: string | DDLTriggerCallback,
    tags?: string[],
  ): void {
    const timing = event === 'ddl_command_start' ? 'before' : 'after';

    const trigger: DDLTrigger = {
      name,
      event,
      callback: typeof callback === 'string' ? callback : `function_${name}`,
      timing,
      enabled: true,
    };

    // Only add tags if non-empty
    if (tags && tags.length > 0) {
      trigger.tags = tags;
    }

    this.triggers.set(name, trigger);

    if (typeof callback === 'function') {
      // Key the callback map by the trigger's stored callback identifier
      // (`function_${name}`) so firing by `trigger.callback` resolves it.
      this.callbacks.set(trigger.callback, callback);
    }

    this.logger.info({ name, event, tags: trigger.tags }, 'DDL trigger created');
  }

  /**
   * Parse a `CREATE EVENT TRIGGER` SQL statement and register it.
   *
   * @param sql - The CREATE EVENT TRIGGER DDL statement.
   */
  createTriggerFromSQL(sql: string): void {
    const config = parseCreateEventTrigger(sql);
    if (!config) {
      this.logger.warn({ sql: sql.substring(0, 80) }, 'Failed to parse CREATE EVENT TRIGGER');
      return;
    }

    this.createTrigger(config.name, config.event, `event_${config.name}`, config.tags);
  }

  /**
   * Drop an existing DDL trigger by name.
   *
   * @param name - Name of the trigger to drop.
   */
  dropTrigger(name: string): void {
    this.triggers.delete(name);
    this.callbacks.delete(name);
    this.logger.info({ name }, 'DDL trigger dropped');
  }

  /**
   * Alter an event trigger's enabled state (PG-compatible).
   * Supports: ALTER EVENT TRIGGER name DISABLE | ENABLE
   *
   * @param name   - Trigger name.
   * @param action - 'DISABLE' or 'ENABLE'.
   * @returns true if the trigger was found and altered.
   */
  alterEventTrigger(name: string, action: 'DISABLE' | 'ENABLE'): boolean {
    const trigger = this.triggers.get(name);
    if (!trigger) {
      this.logger.warn({ name }, 'ALTER EVENT TRIGGER: trigger not found');
      return false;
    }

    trigger.enabled = action === 'ENABLE';
    this.logger.info({ name, enabled: trigger.enabled }, 'ALTER EVENT TRIGGER executed');
    return true;
  }

  /**
   * Parse and execute an ALTER EVENT TRIGGER SQL statement.
   *
   * @param sql - The ALTER EVENT TRIGGER DDL statement.
   * @returns true if successful.
   */
  alterEventTriggerFromSQL(sql: string): boolean {
    const trimmed = sql.trim();
    const match = trimmed.match(
      /ALTER\s+EVENT\s+TRIGGER\s+(\w+)\s+(DISABLE|ENABLE)/i,
    );
    if (!match) {
      this.logger.warn({ sql: sql.substring(0, 80) }, 'Failed to parse ALTER EVENT TRIGGER');
      return false;
    }

    return this.alterEventTrigger(match[1], match[2].toUpperCase() as 'DISABLE' | 'ENABLE');
  }

  /**
   * Fire all `ddl_command_start` triggers before a DDL statement.
   *
   * @param sql - The DDL SQL statement about to be executed.
   */
  fireBefore(sql: string): void {
    if (!this.isDDL(sql)) return;

    const tag = extractDDLTag(sql);
    this.transientDDLCommand = this.buildDDLCommandInfo(sql, tag);

    const matchingTriggers = this.getTriggersForEvent('ddl_command_start');

    for (const trigger of matchingTriggers) {
      if (!trigger.enabled) continue;

      // Check tag filter
      if (trigger.tags && trigger.tags.length > 0 && !trigger.tags.includes(tag)) {
        continue;
      }

      this.logger.info({ trigger: trigger.name, sql: sql.substring(0, 100) }, 'DDL trigger (before)');

      const callback = this.callbacks.get(trigger.callback);
      if (callback) {
        try {
          callback(sql, 'ddl_command_start');
        } catch (err) {
          this.logger.error(
            { trigger: trigger.name, err },
            'DDL trigger before-callback failed',
          );
        }
      }
    }
  }

  /**
   * Fire all `ddl_command_end` triggers after a DDL statement.
   *
   * @param sql    - The DDL SQL statement that was executed.
   * @param result - The result of the DDL execution.
   */
  fireAfter(sql: string, result: any): void {
    if (!this.isDDL(sql)) return;

    const tag = extractDDLTag(sql);
    this.transientDDLCommand = this.buildDDLCommandInfo(sql, tag);

    const matchingTriggers = this.getTriggersForEvent('ddl_command_end');

    for (const trigger of matchingTriggers) {
      if (!trigger.enabled) continue;

      // Check tag filter
      if (trigger.tags && trigger.tags.length > 0 && !trigger.tags.includes(tag)) {
        continue;
      }

      this.logger.info(
        { trigger: trigger.name, sql: sql.substring(0, 100) },
        'DDL trigger (after)',
      );

      const callback = this.callbacks.get(trigger.callback);
      if (callback) {
        try {
          callback(sql, 'ddl_command_end');
        } catch (err) {
          this.logger.error(
            { trigger: trigger.name, err },
            'DDL trigger after-callback failed',
          );
        }
      }
    }

    // Clear transient state
    this.transientDDLCommand = null;

    // ── Apply default privileges on CREATE statements ─────────
    if (this.defaultPrivilegeApplier) {
      const createInfo = this.extractCreatedObject(sql);
      if (createInfo) {
        try {
          this.defaultPrivilegeApplier(
            createInfo.objectType,
            createInfo.schemaName,
            createInfo.objectName,
          );
        } catch (err) {
          this.logger.error({ err, sql: sql.substring(0, 100) }, 'Default privilege application failed');
        }
      }
    }
  }

  /**
   * Fire all `sql_drop` triggers after a DROP statement.
   *
   * Must be called AFTER DROP execution but with the dropped objects
   * that were captured BEFORE execution (via captureDroppedObjects).
   *
   * Inside the callback, use `pgEventTriggerDroppedObjects()` to access
   * dropped object info (PG-compatible approach).
   *
   * @param sql            - The DROP SQL statement that was executed.
   * @param droppedObjects - Objects that were dropped (captured before DROP).
   */
  fireSqlDrop(sql: string, droppedObjects: DroppedObject[]): void {
    if (!isDropStatement(sql)) return;

    // Set transient state for pg_event_trigger_dropped_objects()
    this.transientDroppedObjects = [...droppedObjects];

    const tag = extractDDLTag(sql);
    this.transientDDLCommand = this.buildDDLCommandInfo(sql, tag);

    const matchingTriggers = this.getTriggersForEvent('sql_drop');

    for (const trigger of matchingTriggers) {
      if (!trigger.enabled) continue;

      // Check tag filter
      if (trigger.tags && trigger.tags.length > 0 && !trigger.tags.includes(tag)) {
        continue;
      }

      this.logger.info(
        { trigger: trigger.name, sql: sql.substring(0, 100), objects: droppedObjects.length },
        'DDL trigger (sql_drop)',
      );

      // Call with standard DDLTriggerCallback signature (sql, event)
      // Dropped objects accessible via pgEventTriggerDroppedObjects()
      const callback = this.callbacks.get(trigger.callback);
      if (callback) {
        try {
          callback(sql, 'sql_drop');
        } catch (err) {
          this.logger.error(
            { trigger: trigger.name, err },
            'DDL trigger sql_drop callback failed',
          );
        }
      }
    }

    // Clear transient state
    this.transientDroppedObjects = [];
    this.transientDDLCommand = null;
  }

  // ── Pseudo-function: pg_event_trigger_ddl_commands() ─────────

  /**
   * PG-compatible pseudo-function: returns DDL command info for the
   * currently executing DDL statement.
   *
   * Returns a list matching `pg_event_trigger_ddl_commands()` output.
   * Valid only within event trigger callbacks.
   */
  pgEventTriggerDDLCommands(): DDLCommandInfo[] {
    if (!this.transientDDLCommand) return [];
    return [this.transientDDLCommand];
  }

  // ── Pseudo-function: pg_event_trigger_dropped_objects() ──────

  /**
   * PG-compatible pseudo-function: returns dropped object info for the
   * currently executing DROP statement.
   *
   * Returns a list matching `pg_event_trigger_dropped_objects()` output.
   * Valid only within sql_drop event trigger callbacks.
   */
  pgEventTriggerDroppedObjects(): DroppedObject[] {
    return [...this.transientDroppedObjects];
  }

  /**
   * Capture dropped objects BEFORE a DROP statement executes.
   * Typically called by QueryRouter after querying sqlite_master.
   *
   * @param objects - Objects that will be dropped.
   */
  captureDroppedObjects(objects: DroppedObject[]): void {
    this.transientDroppedObjects = [...objects];
  }

  /**
   * Extract dropped objects from a DROP SQL statement.
   * This parses the SQL to determine what objects might be dropped,
   * without needing an actual sqlite_master snapshot.
   *
   * @param sql - DROP SQL statement.
   * @returns Array of DroppedObject entries derived from the SQL.
   */
  extractDroppedObjectsFromSQL(sql: string): DroppedObject[] {
    if (!isDropStatement(sql)) return [];

    const objectType = extractDropObjectType(sql);
    const targets = extractDropTargets(sql);

    return targets.map((t) => ({
      type: objectType,
      schema: t.schema,
      name: t.name,
    }));
  }

  // ── Enable / Disable ────────────────────────────────────────

  /**
   * Enable or disable a trigger by name.
   *
   * @param name    - Trigger name.
   * @param enabled - Whether to enable.
   */
  setTriggerEnabled(name: string, enabled: boolean): void {
    const trigger = this.triggers.get(name);
    if (trigger) {
      trigger.enabled = enabled;
      this.logger.info({ name, enabled }, 'DDL trigger enabled state changed');
    }
  }

  // ── Query methods ───────────────────────────────────────────

  /**
   * Get all registered triggers.
   */
  getAllTriggers(): DDLTrigger[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Get all triggers as EventTriggerConfig array (PG-compatible).
   */
  getAllEventTriggerConfigs(): EventTriggerConfig[] {
    return Array.from(this.triggers.values()).map((t) => ({
      name: t.name,
      event: t.event,
      tags: t.tags,
      functionName: t.callback,
      enabled: t.enabled,
    }));
  }

  /**
   * Get triggers for a specific event type.
   *
   * @param event - Event type.
   */
  getTriggersForEvent(event: DDLTriggerEvent): DDLTrigger[] {
    return Array.from(this.triggers.values()).filter(
      (t) => t.event === event,
    );
  }

  /**
   * Get a trigger by name.
   *
   * @param name - Trigger name.
   * @returns The trigger, or `undefined`.
   */
  getTrigger(name: string): DDLTrigger | undefined {
    return this.triggers.get(name);
  }

  /**
   * Check whether a SQL statement is a DDL statement.
   *
   * @param sql - SQL statement to check.
   * @returns `true` if the statement is DDL.
   */
  isDDL(sql: string): boolean {
    const trimmed = sql.trim();
    return DDL_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Register a named function callback that can be referenced by triggers.
   *
   * @param name     - Callback name.
   * @param callback - The callback function.
   */
  registerCallback(name: string, callback: DDLTriggerCallback): void {
    this.callbacks.set(name, callback);
    this.logger.info({ name }, 'DDL callback registered');
  }

  /**
   * Set the default privilege applier callback.
   * This callback is invoked after a CREATE statement to apply default privileges
   * to the newly created object.
   *
   * @param applier - Callback receiving (objectType, schemaName, objectName).
   */
  setDefaultPrivilegeApplier(
    applier: (objectType: string, schemaName: string | null, objectName: string) => void,
  ): void {
    this.defaultPrivilegeApplier = applier;
    this.logger.info('Default privilege applier registered');
  }

  /**
   * Extract information about a created object from a CREATE SQL statement.
   *
   * Returns a CreatedObjectInfo if the statement is a CREATE TABLE/VIEW/SEQUENCE/TYPE/INDEX,
   * or null otherwise.
   *
   * @param sql - The DDL SQL statement.
   * @returns CreatedObjectInfo or null if not a CREATE statement.
   */
  extractCreatedObject(sql: string): CreatedObjectInfo | null {
    const trimmed = sql.trim();
    const match = CREATE_OBJECT_RE.exec(trimmed);

    if (!match) return null;

    const objectType = match[1].toUpperCase();
    const schemaName = match[2] || null;
    const objectName = match[3];

    return { objectType, schemaName, objectName };
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.triggers.clear();
    this.callbacks.clear();
    this.transientDroppedObjects = [];
    this.transientDDLCommand = null;
    this.defaultPrivilegeApplier = undefined;
    this.logger.info('DDLTriggerManager state reset');
  }

  // ── Internal helpers ────────────────────────────────────────

  /**
   * Build DDLCommandInfo from SQL and tag.
   */
  private buildDDLCommandInfo(sql: string, tag: string): DDLCommandInfo {
    const tags2 = tag.split(' ');
    const objectType = tags2.length >= 2 ? tags2[1].toLowerCase() : 'unknown';
    const identity = this.extractObjectNameFromSQL(sql);

    return {
      ddlTag: tag,
      objectType,
      schema: 'public',
      identity,
      inExtension: false,
    };
  }

  /**
   * Extract the object name from a DDL SQL statement (basic heuristic).
   */
  private extractObjectNameFromSQL(sql: string): string {
    const trimmed = sql.trim();
    // Try CREATE TABLE / VIEW name
    const createMatch = trimmed.match(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:\w+\s+)+(\w+)/i);
    if (createMatch) return createMatch[1];

    // Try DROP type name
    const dropMatch = trimmed.match(/^\s*DROP\s+\w+\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    if (dropMatch) return dropMatch[1];

    // Try ALTER type name
    const alterMatch = trimmed.match(/^\s*ALTER\s+\w+\s+(\w+)/i);
    if (alterMatch) return alterMatch[1];

    return 'unknown';
  }
}
