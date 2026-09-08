/**
 * Registry for tenant-scoped tables created imperatively outside Drizzle.
 * Disco currently has no such tables, but the empty registry remains part of
 * the tenant deletion contract so future runtime-owned tables fail closed.
 */

/** The column that scopes an imperative table's rows to a tenant. */
export const IMPERATIVE_TENANT_SCOPE_COLUMN = 'tenant_id';

/**
 * A tenant-scoped table created imperatively (outside the Drizzle schema) and
 * therefore not derivable from `schema.postgres.ts`. Entries describe only the
 * relation used for explicit public-qualified tenant DML. They do not claim to
 * validate row-level foreign-key tenant consistency.
 */
export interface ImperativeTenantTable {
  /** Physical table name (constant — never sourced from the live catalog). */
  readonly name: string;
  /** Tenant discriminator column (always deleted with `WHERE <col> = $1`). */
  readonly tenantColumn: string;
}

/** Runtime-owned imperative tenant tables, currently empty. */
export const IMPERATIVE_TENANT_TABLES: readonly ImperativeTenantTable[] = [];
