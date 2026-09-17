/**
 * TDEConfig — transparent data encryption configuration and policy store.
 *
 * Centralizes the runtime state behind TDE: whether encryption is enabled, the
 * active cipher, the master key (from the environment), and the named
 * encryption policies manipulated by the `EncryptionPolicyShim`
 * (CREATE/ALTER/DROP ENCRYPTION POLICY …).
 *
 * The state is module-scoped (the TDE settings are process-global), so the
 * public API is a set of static methods.  `loadFromEnv()` returns a snapshot
 * object consumed by the engine; the mutating policy methods affect the shared
 * module state that `getEnabled()/getAlgorithm()` then report.
 *
 * @module tde/TDEConfig
 */

/** Supported AES-GCM cipher families. */
export type TDEAlgorithm = 'aes-256-gcm' | 'aes-192-gcm' | 'aes-128-gcm';

/** Number of key bytes each cipher family requires. */
const KEY_LENGTH_MAP: Record<TDEAlgorithm, number> = {
  'aes-256-gcm': 32,
  'aes-192-gcm': 24,
  'aes-128-gcm': 16,
};

/** Environment variable names used to bootstrap TDE. */
const ENV_ENABLED = 'SQLVEC_TDE_ENABLED';
const ENV_KEY = 'SQLVEC_TDE_KEY';
const ENV_ALGORITHM = 'SQLVEC_TDE_ALGORITHM';

/** Default cipher when none is configured. */
const DEFAULT_ALGORITHM: TDEAlgorithm = 'aes-256-gcm';

/** A single named encryption policy. */
export interface EncryptionPolicy {
  name: string;
  algorithm: TDEAlgorithm;
}

// ── Module-scoped runtime state ────────────────────────────────

let enabled = false;
let algorithm: TDEAlgorithm = DEFAULT_ALGORITHM;
let key: string | undefined;
let policiesDir: string | undefined;
const policies = new Map<string, EncryptionPolicy>();

/**
 * Transparent data encryption configuration.
 *
 * Instances are lightweight snapshots of the module state (returned by
 * `loadFromEnv()`); configuration itself is managed through the static API.
 */
export class TDEConfig {
  enabled = false;
  algorithm: TDEAlgorithm = DEFAULT_ALGORITHM;
  key?: string;

  /**
   * Build a snapshot of the current TDE state, reading any not-yet-loaded
   * settings from the environment first.
   */
  static loadFromEnv(): TDEConfig {
    TDEConfig.initFromEnv();
    const cfg = new TDEConfig();
    cfg.enabled = enabled;
    cfg.algorithm = algorithm;
    cfg.key = key;
    return cfg;
  }

  /** Record the directory where encryption policies are persisted. */
  static setPoliciesDir(dir: string): void {
    policiesDir = dir;
  }

  /** The currently configured policies directory, if any. */
  static getPoliciesDir(): string | undefined {
    return policiesDir;
  }

  /**
   * (Re)load settings from the environment.  Idempotent; unset variables leave
   * the corresponding value unchanged.
   */
  static initFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    if (env[ENV_ENABLED] !== undefined) {
      enabled = env[ENV_ENABLED] === 'true' || env[ENV_ENABLED] === '1';
    }
    if (env[ENV_KEY] !== undefined) {
      key = env[ENV_KEY] || undefined;
    }
    if (env[ENV_ALGORITHM] !== undefined) {
      const alg = env[ENV_ALGORITHM];
      if (isTDEAlgorithm(alg)) algorithm = alg;
    }
  }

  /**
   * Validate a master key.  A key is valid when it is base64-decodable and its
   * decoded length matches one of the supported AES-GCM key sizes (16/24/32
   * bytes).  This guards key rotation against malformed or wrong-sized keys.
   */
  static validateKey(keyValue: unknown): boolean {
    if (typeof keyValue !== 'string' || keyValue.length === 0) return false;
    // Reject non-canonical base64 (stray characters, non-alphabet symbols).
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(keyValue)) return false;
    // Buffer.from(..., 'base64') never throws (it tolerates invalid input), so
    // the regex above is the authoritative format check; the decoded length
    // below is the final gate.
    const decoded = Buffer.from(keyValue, 'base64');
    return Object.values(KEY_LENGTH_MAP).includes(decoded.length);
  }

  // ── Runtime state accessors ──────────────────────────────────

  /** Whether TDE is currently enabled. */
  static getEnabled(): boolean {
    return enabled;
  }

  /** Enable or disable TDE at runtime. */
  static setEnabled(value: boolean): void {
    enabled = value;
  }

  /** The active cipher family. */
  static getAlgorithm(): TDEAlgorithm {
    return algorithm;
  }

  /** Set the active cipher, throwing on an unsupported algorithm. */
  static setAlgorithm(value: string): void {
    if (!isTDEAlgorithm(value)) {
      throw new Error(`Unsupported TDE algorithm: ${value}`);
    }
    algorithm = value;
  }

  // ── Named encryption policies ────────────────────────────────

  /** Create (or overwrite) a named encryption policy. */
  static createPolicy(name: string, value: string): void {
    const normalized = normalizeAlgorithm(value);
    if (!normalized) {
      throw new Error(`Unsupported TDE algorithm for policy "${name}": ${value}`);
    }
    policies.set(name.toLowerCase(), { name, algorithm: normalized });
  }

  /** Look up a named policy, or `undefined` if none exists. */
  static getPolicy(name: string): EncryptionPolicy | undefined {
    return policies.get(name.toLowerCase());
  }

  /** Remove a named policy.  Returns whether a policy was removed. */
  static dropPolicy(name: string): boolean {
    return policies.delete(name.toLowerCase());
  }

  /** All named policies (snapshot). */
  static listPolicies(): EncryptionPolicy[] {
    return Array.from(policies.values()).map((p) => ({ ...p }));
  }

  /**
   * Reset the module state to its initial (disabled, default algorithm, no key,
   * no policies) configuration.
   */
  static reset(): void {
    enabled = false;
    algorithm = DEFAULT_ALGORITHM;
    key = undefined;
    policiesDir = undefined;
    policies.clear();
  }
}

/** Whether a string names a supported TDE algorithm. */
function isTDEAlgorithm(value: unknown): value is TDEAlgorithm {
  return value === 'aes-256-gcm' || value === 'aes-192-gcm' || value === 'aes-128-gcm';
}

/** Normalize an arbitrary algorithm string to a supported `TDEAlgorithm`. */
function normalizeAlgorithm(value: string): TDEAlgorithm | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'aes256' || v === 'aes-256' || v === 'aes-256-gcm') return 'aes-256-gcm';
  if (v === 'aes192' || v === 'aes-192' || v === 'aes-192-gcm') return 'aes-192-gcm';
  if (v === 'aes128' || v === 'aes-128' || v === 'aes-128-gcm') return 'aes-128-gcm';
  return undefined;
}
