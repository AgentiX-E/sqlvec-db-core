/**
 * CertMappingStore — in-memory certificate-to-user mapping store.
 *
 * PostgreSQL certificate authentication maps a client certificate's Common
 * Name (CN) to a database user.  This store is the single source of truth for
 * those mappings, consumed by {@link query/CertMapShim} when it processes
 * `CREATE/ALTER/DROP USER MAPPING` DDL and by the authentication layer when it
 * resolves a certificate CN to a database role.
 *
 * The store is a process-wide singleton backed by a `Map<string, string>` keyed
 * by certificate Common Name.  Because mappings are security-sensitive, all
 * accessors return defensive copies rather than the live internal map.
 *
 * @module auth/CertMappingStore
 */

/** A read-only view of all certificate mappings (CN → database user). */
export type CertMappings = ReadonlyMap<string, string>;

/**
 * Certificate-to-user mapping store.
 *
 * Thread/async safety is provided by synchronous mutation of a single `Map`
 * instance guarded by a singleton.  Mappings are keyed by certificate CN so a
 * single certificate can map to one user, while multiple certificates may map
 * to the same user.
 */
export class CertMappingStore {
  private readonly mappings = new Map<string, string>();

  private static instance: CertMappingStore | null = null;

  /**
   * Return the process-wide singleton instance, creating it on first use.
   */
  static getInstance(): CertMappingStore {
    if (!CertMappingStore.instance) {
      CertMappingStore.instance = new CertMappingStore();
    }
    return CertMappingStore.instance;
  }

  /**
   * Create a new, isolated store.  Unlike {@link getInstance}, this always
   * returns a fresh instance and is intended for tests and multi-tenant
   * boundaries where an independent store is required.
   */
  static create(): CertMappingStore {
    return new CertMappingStore();
  }

  /**
   * Associate a certificate Common Name with a database user.
   *
   * Overwrites any previous mapping for the same CN.
   *
   * @param certCN   The certificate Common Name.
   * @param dbUser   The database user (role) to map the certificate to.
   */
  setMapping(certCN: string, dbUser: string): void {
    this.mappings.set(certCN, dbUser);
  }

  /**
   * Remove the mapping for a given certificate Common Name.
   *
   * @param certCN   The certificate Common Name to unmap.
   * @returns `true` if a mapping existed and was removed, otherwise `false`.
   */
  removeMapping(certCN: string): boolean {
    return this.mappings.delete(certCN);
  }

  /**
   * Remove every mapping whose database user equals `dbUser`.
   *
   * PostgreSQL `DROP USER MAPPING FOR user` drops the user's foreign-server
   * mappings; here it clears all certificate CNs mapped to that user.
   *
   * @param dbUser   The database user whose mappings should be removed.
   * @returns The number of mappings removed.
   */
  removeMappingByDbUser(dbUser: string): number {
    let removed = 0;
    for (const [cn, user] of this.mappings) {
      if (user === dbUser) {
        this.mappings.delete(cn);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Resolve a certificate Common Name to a database user.
   *
   * @param certCN   The certificate Common Name to look up.
   * @returns The mapped database user, or `undefined` if no mapping exists.
   */
  map(certCN: string): string | undefined {
    return this.mappings.get(certCN);
  }

  /**
   * Return a defensive snapshot of all certificate mappings.
   */
  getAllMappings(): CertMappings {
    return new Map(this.mappings);
  }

  /** Number of stored mappings. */
  get size(): number {
    return this.mappings.size;
  }

  /** Whether the store is empty. */
  get isEmpty(): boolean {
    return this.mappings.size === 0;
  }
}

/**
 * Convenience factory for callers that import `create` directly (e.g.
 * {@link query/CertMapShim}).  Returns a fresh store instance.
 */
export function create(): CertMappingStore {
  return CertMappingStore.create();
}
