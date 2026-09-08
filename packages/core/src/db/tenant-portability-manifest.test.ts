/**
 * Unit coverage for the portability insert ordering. The import order must be the
 * exact reverse of the deletion (child-first) order, which guarantees every
 * foreign-key parent is inserted before any row that references it.
 */

import { describe, expect, it } from 'vitest';
import { buildTenantDeletionManifest } from './tenant-deletion-manifest';
import {
  buildTenantInsertOrder,
  derivedImperativeTableNames,
  nonPortableTenantTableNames,
  tenantPortabilityForeignKeys,
  tenantPortabilityTableNames,
} from './tenant-portability-manifest';

describe('buildTenantInsertOrder', () => {
  it('is the exact reverse of the deletion (child-first) order', () => {
    const nonPortable = new Set(nonPortableTenantTableNames());
    const deletion = buildTenantDeletionManifest()
      .map((entry) => entry.name)
      .filter((name) => !nonPortable.has(name));
    const insert = buildTenantInsertOrder().map((entry) => entry.name);
    expect(insert).toEqual([...deletion].reverse());
  });

  it('scopes every table by tenant_id', () => {
    for (const table of buildTenantInsertOrder()) {
      expect(table.tenantColumn).toBe('tenant_id');
    }
  });

  it('covers exactly the compiled tenant tables', () => {
    const insertNames = buildTenantInsertOrder()
      .map((entry) => entry.name)
      .sort();
    expect(insertNames).toEqual(tenantPortabilityTableNames());
  });

  it('does not move derived imperative tables as rows', () => {
    const insertNames = new Set(buildTenantInsertOrder().map((entry) => entry.name));
    for (const derived of derivedImperativeTableNames()) {
      expect(insertNames.has(derived)).toBe(false);
    }
  });

  it('deletes but never exports transient authorities or deployment-bound grants', () => {
    const nonPortable = nonPortableTenantTableNames();
    expect(nonPortable).toEqual([
      'executor_session_token_authorities',
      'github_install_states',
      'mcp_oauth_pending_flows',
      'user_mcp_oauth_tokens',
    ]);
    for (const tableName of nonPortable) {
      expect(buildTenantDeletionManifest().map((entry) => entry.name)).toContain(tableName);
      expect(buildTenantInsertOrder().map((entry) => entry.name)).not.toContain(tableName);
    }
  });
});

describe('tenantPortabilityForeignKeys', () => {
  it('freezes the exact schema-derived movable FK set', () => {
    const foreignKeys = tenantPortabilityForeignKeys();
    expect(foreignKeys).toHaveLength(22);
    expect(Object.isFrozen(foreignKeys)).toBe(true);
    const structuralKeys = foreignKeys.map((foreignKey) =>
      [
        foreignKey.childTable,
        foreignKey.childColumns.join(','),
        foreignKey.parentTable,
        foreignKey.parentColumns.join(','),
      ].join('|')
    );
    expect(new Set(structuralKeys).size).toBe(foreignKeys.length);
    for (const foreignKey of foreignKeys) {
      expect(Object.isFrozen(foreignKey)).toBe(true);
      expect(Object.isFrozen(foreignKey.childColumns)).toBe(true);
      expect(Object.isFrozen(foreignKey.parentColumns)).toBe(true);
    }
  });

  it('does not classify deployment-bound MCP OAuth grant relations as movable', () => {
    expect(tenantPortabilityForeignKeys()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ childTable: 'user_mcp_oauth_tokens' })])
    );
  });

  it('moves direct Agent ownership with Sessions and Schedules', () => {
    const foreignKeys = tenantPortabilityForeignKeys();
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childTable: 'sessions',
          childColumns: ['agent_id'],
          parentTable: 'agents',
          parentColumns: ['agent_id'],
          onDelete: 'set null',
        }),
        expect.objectContaining({
          childTable: 'schedules',
          childColumns: ['agent_id'],
          parentTable: 'agents',
          parentColumns: ['agent_id'],
          onDelete: 'cascade',
        }),
      ])
    );
  });

  it('does not retain retired architecture or database-knowledge relations', () => {
    const retired = /^(?:artifact|board|branch|card|gateway|kb_|repo|thread_session_map)/u;
    for (const foreignKey of tenantPortabilityForeignKeys()) {
      expect(foreignKey.childTable).not.toMatch(retired);
      expect(foreignKey.parentTable).not.toMatch(retired);
    }
  });
});
