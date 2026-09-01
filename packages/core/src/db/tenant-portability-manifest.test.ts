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
      'codex_device_auth_attempts',
      'executor_session_token_authorities',
      'github_install_states',
      'mcp_oauth_client_registrations',
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
    expect(foreignKeys).toHaveLength(109);
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

  it('moves normalized board and branch policies with their resources and principals', () => {
    expect(tenantPortabilityForeignKeys()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childTable: 'board_access_entries',
          childColumns: ['tenant_id', 'board_id'],
          parentTable: 'board_access_policies',
          parentColumns: ['tenant_id', 'board_id'],
          onDelete: 'cascade',
        }),
        expect.objectContaining({
          childTable: 'branch_permission_entries',
          childColumns: ['tenant_id', 'config_id'],
          parentTable: 'branch_permission_configs',
          parentColumns: ['tenant_id', 'config_id'],
          onDelete: 'cascade',
        }),
      ])
    );
  });

  it('does not classify deployment-bound MCP OAuth grant relations as movable', () => {
    expect(tenantPortabilityForeignKeys()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ childTable: 'user_mcp_oauth_tokens' })])
    );
  });

  it('moves external identity bindings with their projected users', () => {
    expect(tenantPortabilityForeignKeys()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childTable: 'user_external_identities',
          childColumns: ['tenant_id', 'user_id'],
          parentTable: 'users',
          parentColumns: ['tenant_id', 'user_id'],
          onDelete: 'cascade',
        }),
      ])
    );
  });

  it('moves inbound event relations with their channel, Session, and Task', () => {
    expect(tenantPortabilityForeignKeys()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childTable: 'gateway_inbound_events',
          childColumns: ['gateway_channel_id'],
          parentTable: 'gateway_channels',
          parentColumns: ['id'],
          onDelete: 'cascade',
        }),
        expect.objectContaining({
          childTable: 'gateway_inbound_events',
          childColumns: ['session_id'],
          parentTable: 'sessions',
          parentColumns: ['session_id'],
          onDelete: 'set null',
        }),
        expect.objectContaining({
          childTable: 'gateway_inbound_events',
          childColumns: ['task_id'],
          parentTable: 'tasks',
          parentColumns: ['task_id'],
          onDelete: 'set null',
        }),
      ])
    );
  });

  it('includes both sides of the boards and branches cycle', () => {
    const foreignKeys = tenantPortabilityForeignKeys();
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childTable: 'boards',
          childColumns: ['primary_teammate_id'],
          parentTable: 'branches',
          parentColumns: ['branch_id'],
          onDelete: 'set null',
        }),
        expect.objectContaining({
          childTable: 'branches',
          childColumns: ['board_id'],
          parentTable: 'boards',
          parentColumns: ['board_id'],
          onDelete: 'set null',
        }),
      ])
    );
  });
});
