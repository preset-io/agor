/**
 * MCP Server Repository
 *
 * Type-safe CRUD operations for MCP servers with short ID support.
 */

import type {
  CreateMCPServerInput,
  MCPAuth,
  MCPServer,
  MCPServerFilters,
  MCPServerID,
  MCPServerSortField,
  UpdateMCPServerInput,
  UserID,
} from '@agor/core/types';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { PAGINATION } from '../../config/constants';
import { generateId } from '../../lib/ids';
import {
  assertValidMCPAuthPatch,
  MCPAuthValidationError,
  mergeMCPAuth,
  replaceMCPAuth,
} from '../../tools/mcp/auth-patch';
import { restoreRedactedMCPEnvSecrets } from '../../tools/mcp/env-secrets';
import {
  normalizeMCPCustomHeaders,
  restoreRedactedMCPCustomHeaders,
} from '../../tools/mcp/http-headers';
import {
  assertValidEffectiveMCPServer,
  MCPServerWriteValidationError,
} from '../../tools/mcp/server-validation';
import { assertPublicMCPOAuthCompatibilityMode } from '../../types/mcp';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  appVariables,
  type MCPServerInsert,
  type MCPServerRow,
  mcpServers,
  sessionMcpServers,
} from '../schema';
import { runWithTenantDatabaseTransaction } from '../tenant-scope';
import { AppVariableRepository } from './app-variables';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';

/** Compare-and-swap failure for a stale MCP configuration editor. */
export class MCPServerConfigConflictError extends Error {
  constructor(
    readonly mcpServerId: MCPServerID,
    readonly expectedVersion: number,
    readonly actualVersion: number
  ) {
    super(
      `MCP server configuration changed (expected version ${expectedVersion}, current version ${actualVersion})`
    );
    this.name = 'MCPServerConfigConflictError';
  }
}

export interface MCPServerUpdateOptions {
  /** Feathers PUT: omitted mutable configuration is cleared instead of merged. */
  replace?: boolean;
}

const MCP_SERVER_SORT_COLUMNS: Record<MCPServerSortField, AnyColumn> = {
  mcp_server_id: mcpServers.mcp_server_id,
  name: mcpServers.name,
  transport: mcpServers.transport,
  scope: mcpServers.scope,
  enabled: mcpServers.enabled,
  source: mcpServers.source,
  created_at: mcpServers.created_at,
  updated_at: mcpServers.updated_at,
};

function buildMCPServerConditions(filters?: MCPServerFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters?.scope) conditions.push(eq(mcpServers.scope, filters.scope));
  if (filters?.transport) conditions.push(eq(mcpServers.transport, filters.transport));
  if (filters?.enabled !== undefined) conditions.push(eq(mcpServers.enabled, filters.enabled));
  if (filters?.source) conditions.push(eq(mcpServers.source, filters.source));
  if (filters?.catalogEntryName) {
    conditions.push(eq(mcpServers.catalog_entry_name, filters.catalogEntryName));
  }
  if (filters?.usableByUserId) {
    const usable = or(
      isNull(mcpServers.owner_user_id),
      eq(mcpServers.owner_user_id, filters.usableByUserId)
    );
    if (usable) conditions.push(usable);
  }
  if (filters?.ownerless) conditions.push(isNull(mcpServers.owner_user_id));
  return conditions;
}

function mergeServerConfiguration(
  current: MCPServer,
  updates: UpdateMCPServerInput,
  nextConfigVersion: number,
  options: MCPServerUpdateOptions
): MCPServer {
  const {
    expected_config_version: _expectedConfigVersion,
    auth: authPatch,
    replace_auth: replaceAuth,
    ...persistedUpdates
  } = updates;
  const replacing = options.replace === true;
  const merged: MCPServer = {
    ...current,
    ...persistedUpdates,
    config_version: nextConfigVersion,
  };

  if (replacing) {
    merged.display_name = persistedUpdates.display_name;
    merged.description = persistedUpdates.description;
    merged.command = persistedUpdates.command;
    merged.args = persistedUpdates.args;
    merged.url = persistedUpdates.url;
    merged.tool_permissions = persistedUpdates.tool_permissions;
  }

  if ('headers' in updates || replacing) {
    merged.headers =
      'headers' in updates
        ? restoreRedactedMCPCustomHeaders({ current: current.headers, next: updates.headers })
        : undefined;
  }
  if ('env' in updates || replacing) {
    merged.env =
      'env' in updates
        ? restoreRedactedMCPEnvSecrets({ current: current.env, next: updates.env })
        : undefined;
  }
  if ('auth' in updates) {
    const shouldReplaceAuth = replaceAuth ?? replacing;
    merged.auth = shouldReplaceAuth
      ? replaceMCPAuth(current.auth, authPatch)
      : mergeMCPAuth(current.auth, authPatch);
  } else if (replacing) {
    merged.auth = undefined;
  }

  const transportChanged =
    persistedUpdates.transport !== undefined && persistedUpdates.transport !== current.transport;
  if (transportChanged) {
    if (merged.transport === 'stdio') {
      if (!Object.hasOwn(updates, 'command')) {
        throw new MCPServerWriteValidationError(
          'command is required when changing transport to stdio'
        );
      }
      merged.url = undefined;
      merged.headers = undefined;
      merged.auth = undefined;
    } else {
      if (!Object.hasOwn(updates, 'url')) {
        throw new MCPServerWriteValidationError(
          `url is required when changing transport to ${merged.transport}`
        );
      }
      merged.command = undefined;
      merged.args = undefined;
    }
  } else if (merged.transport === 'stdio') {
    if (
      ('url' in updates && updates.url !== undefined) ||
      ('headers' in updates && updates.headers !== undefined) ||
      ('auth' in updates && updates.auth !== undefined && updates.auth !== null)
    ) {
      throw new MCPServerWriteValidationError(
        'url, headers, and authentication do not apply to stdio transport'
      );
    }
    // Deterministically repair historical inactive fields on the next edit.
    merged.url = undefined;
    merged.headers = undefined;
    merged.auth = undefined;
  } else {
    if (
      ('command' in updates && updates.command !== undefined) ||
      ('args' in updates && updates.args !== undefined)
    ) {
      throw new MCPServerWriteValidationError('command and args only apply to stdio transport');
    }
    merged.command = undefined;
    merged.args = undefined;
  }

  return merged;
}

async function waitForSQLiteBusyRetry(operation: string, attempt: number): Promise<void> {
  const delayMs = Math.min(5 * 2 ** attempt, 100);
  const retryNumber = attempt + 1;
  const message = `[mcp-servers] SQLite busy; retrying ${operation} admission retry=${retryNumber} delay_ms=${delayMs}`;
  if (retryNumber >= 4) console.warn(message);
  else console.debug(message);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function nextMCPConfigVersion(
  current: MCPServer,
  expectedConfigVersion: number | undefined
): number {
  const revision = current.config_version ?? 1;
  if (expectedConfigVersion !== undefined && expectedConfigVersion !== revision) {
    throw new MCPServerConfigConflictError(current.mcp_server_id, expectedConfigVersion, revision);
  }
  if (revision >= Number.MAX_SAFE_INTEGER - 1) {
    // MAX_SAFE_INTEGER is never issued. Once the last advanceable revision is
    // reached, every mutation fails closed rather than wrapping/resetting and
    // making an ancient CAS value authoritative again.
    throw new RepositoryError('MCP server configuration revision is exhausted');
  }
  return revision + 1;
}

function assertStoredMCPConfigVersionCanAdvance(value: unknown): void {
  // Missing/zero revisions are pre-CAS legacy shapes. Their public baseline 1
  // remains recoverable. Positive unsafe or exhausted revisions may have
  // previously issued lower values, so only an explicit administrative repair
  // can change them without introducing ABA.
  if (value === undefined || value === null || value === 0) return;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER - 1
  ) {
    throw new RepositoryError(
      'MCP server configuration revision is invalid or exhausted; administrative repair is required'
    );
  }
}

function projectedMCPConfigVersion(value: unknown, serverId: string): number {
  if (
    value === undefined ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= Number.MAX_SAFE_INTEGER)
  ) {
    return value === undefined ? 1 : Number(value);
  }

  // Normalize only the read projection for legacy/corrupt storage. Mutation
  // independently rejects positive unsafe/exhausted storage, so this fallback
  // can never make an ancient revision 1 authoritative again. Do not log row
  // JSON, display metadata, URLs, or credentials.
  console.warn(`[mcp-servers] Normalizing invalid configuration revision server_id=${serverId}`);
  return 1;
}

/**
 * MCP Server repository implementation
 */
export class MCPServerRepository
  implements BaseRepository<MCPServer, CreateMCPServerInput | UpdateMCPServerInput>
{
  constructor(private db: Database) {}

  private static readonly CATALOG_CONNECT_GENERATION_NAMESPACE = 'mcp-catalog-connect-generation';

  static catalogConnectGenerationKey(ownerUserId: string, catalogEntryName: string): string {
    return JSON.stringify([ownerUserId, catalogEntryName]);
  }

  async claimCatalogConnectGeneration(
    ownerUserId: string,
    catalogEntryName: string
  ): Promise<number> {
    return new AppVariableRepository(this.db).incrementPlainInteger(
      MCPServerRepository.CATALOG_CONNECT_GENERATION_NAMESPACE,
      MCPServerRepository.catalogConnectGenerationKey(ownerUserId, catalogEntryName)
    );
  }

  /**
   * Convert database row to MCPServer type
   */
  private rowToMCPServer(row: MCPServerRow): MCPServer {
    return {
      mcp_server_id: row.mcp_server_id as MCPServerID,
      name: row.name,
      transport: row.transport,
      scope: row.scope,
      enabled: Boolean(row.enabled),
      source: row.source,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : new Date(row.created_at),

      // Optional fields from JSON data
      display_name: row.data.display_name,
      description: row.data.description,
      import_path: row.data.import_path,
      catalog_entry_name: row.catalog_entry_name ?? row.data.catalog_entry_name,

      // Transport config
      command: row.data.command,
      args: row.data.args,
      url: row.data.url,
      headers: row.data.headers,
      env: row.data.env,
      auth: row.data.auth,
      config_version: projectedMCPConfigVersion(row.data.config_version, row.mcp_server_id),

      // Scope foreign key (nullable UUID string - DB stores null, type expects undefined)
      owner_user_id: (row.owner_user_id as UserID | null) ?? undefined,

      // Capabilities
      tools: row.data.tools,
      resources: row.data.resources,
      prompts: row.data.prompts,

      // Tool permissions
      tool_permissions: row.data.tool_permissions,
    };
  }

  /**
   * Convert MCPServer to database insert format
   */
  private mcpServerToInsert(
    data: CreateMCPServerInput | Partial<MCPServer>,
    options: { preserveDaemonRevisions?: boolean } = {}
  ): MCPServerInsert {
    const submittedAuth = 'auth' in data ? (data.auth as unknown) : undefined;
    if (submittedAuth !== undefined) {
      assertValidMCPAuthPatch(submittedAuth, { create: true });
    }
    assertPublicMCPOAuthCompatibilityMode(submittedAuth);
    const now = Date.now();
    const serverId =
      'mcp_server_id' in data && data.mcp_server_id ? data.mcp_server_id : generateId();
    const headers =
      data.transport === 'stdio'
        ? undefined
        : normalizeMCPCustomHeaders('headers' in data ? data.headers : undefined);
    const normalizedAuth = (submittedAuth === null ? undefined : data.auth) as MCPAuth | undefined;
    const effective = {
      ...data,
      headers,
      auth: normalizedAuth,
      source: data.source ?? 'user',
      enabled: data.enabled ?? true,
    } satisfies Partial<MCPServer>;
    assertValidEffectiveMCPServer(effective, {
      allowLegacyProvenance: options.preserveDaemonRevisions,
    });

    return {
      mcp_server_id: serverId as string,
      created_at:
        'created_at' in data && data.created_at ? new Date(data.created_at) : new Date(now),
      updated_at:
        'updated_at' in data && data.updated_at ? new Date(data.updated_at) : new Date(now),

      // Materialized columns
      name: data.name!,
      transport: data.transport!,
      scope: data.scope!,
      enabled: data.enabled ?? true,
      source: data.source ?? 'user',
      catalog_entry_name: data.catalog_entry_name ?? null,

      // Scope foreign key (only for global scope)
      owner_user_id: data.owner_user_id ?? null,

      // JSON blob
      data: {
        display_name: data.display_name,
        description: data.description,
        import_path: data.import_path,
        catalog_entry_name: data.catalog_entry_name,
        // Revisions are daemon-owned. In particular, raw REST/socket callers
        // cannot seed MAX_SAFE_INTEGER and permanently defeat monotonic CAS.
        config_version:
          options.preserveDaemonRevisions && 'config_version' in data
            ? (data.config_version ?? 1)
            : 1,
        command: data.command,
        args: data.args,
        url: data.url,
        headers,
        env: data.env,
        // CREATE auth:null is the explicit unauthenticated form, never a JSON
        // null masquerading as an MCPAuth object in later read paths.
        auth: normalizedAuth,
        tools: 'tools' in data ? data.tools : undefined,
        resources: 'resources' in data ? data.resources : undefined,
        prompts: 'prompts' in data ? data.prompts : undefined,
        tool_permissions: 'tool_permissions' in data ? data.tool_permissions : undefined,
      },
    };
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'MCPServer', async (pattern) => {
      const rows = await select(this.db, { mcp_server_id: mcpServers.mcp_server_id })
        .from(mcpServers)
        .where(like(mcpServers.mcp_server_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { mcp_server_id: string }) => r.mcp_server_id);
    });
  }

  /** Canonical identity for lock keys and multi-step mutation coordination. */
  async resolveCanonicalId(id: string): Promise<MCPServerID> {
    return (await this.resolveId(id)) as MCPServerID;
  }

  /**
   * Materialized columns sufficient for the daemon's write authorizer. This is
   * intentionally not `findById`: deciding ownership/policy must not hydrate
   * bearer tokens, OAuth client secrets, headers, or environment values.
   */
  async getWriteAuthorityProjection(
    id: string
  ): Promise<Pick<MCPServer, 'mcp_server_id' | 'owner_user_id' | 'transport' | 'scope'> | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db, {
        mcp_server_id: mcpServers.mcp_server_id,
        server_id: mcpServers.mcp_server_id,
        owner_user_id: mcpServers.owner_user_id,
        transport: mcpServers.transport,
        scope: mcpServers.scope,
      })
        .from(mcpServers)
        .where(eq(mcpServers.mcp_server_id, fullId))
        .one();
      if (!row) return null;
      return {
        mcp_server_id: row.mcp_server_id as MCPServerID,
        ...(row.owner_user_id ? { owner_user_id: row.owner_user_id as UserID } : {}),
        transport: row.transport,
        scope: row.scope,
      };
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw new RepositoryError(
        `Failed to read MCP server write authority: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Transactional authority read. The row lock orders configuration changes
   * (including HTTP→stdio, scope, and ownership) against the authorization
   * decision and the narrow mutation that follows it.
   */
  async getWriteAuthorityProjectionForUpdate(
    id: string
  ): Promise<Pick<MCPServer, 'mcp_server_id' | 'owner_user_id' | 'transport' | 'scope'> | null> {
    try {
      const fullId = await this.resolveId(id);
      const where = eq(mcpServers.mcp_server_id, fullId);
      await lockRowForUpdate(this.db, this.db, mcpServers, where);
      const row = await select(this.db, {
        mcp_server_id: mcpServers.mcp_server_id,
        owner_user_id: mcpServers.owner_user_id,
        transport: mcpServers.transport,
        scope: mcpServers.scope,
      })
        .from(mcpServers)
        .where(where)
        .one();
      if (!row) return null;
      return {
        mcp_server_id: row.mcp_server_id as MCPServerID,
        ...(row.owner_user_id ? { owner_user_id: row.owner_user_id as UserID } : {}),
        transport: row.transport,
        scope: row.scope,
      };
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw new RepositoryError(
        `Failed to lock MCP server write authority: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Create a new MCP server
   */
  async create(data: CreateMCPServerInput): Promise<MCPServer> {
    try {
      const insertData = this.mcpServerToInsert(data);
      await insert(this.db, mcpServers).values(insertData).run();

      const row = await select(this.db)
        .from(mcpServers)
        .where(eq(mcpServers.mcp_server_id, insertData.mcp_server_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created MCP server');
      }

      return this.rowToMCPServer(row);
    } catch (error) {
      if (
        error instanceof RepositoryError ||
        error instanceof MCPAuthValidationError ||
        error instanceof MCPServerWriteValidationError
      ) {
        throw error;
      }
      throw new RepositoryError(
        `Failed to create MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find MCP server by ID (supports short ID)
   */
  async findById(id: string): Promise<MCPServer | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(mcpServers)
        .where(eq(mcpServers.mcp_server_id, fullId))
        .one();

      return row ? this.rowToMCPServer(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all MCP servers
   */
  async findAll(filters?: MCPServerFilters): Promise<MCPServer[]> {
    try {
      let query = select(this.db).from(mcpServers);

      const conditions = buildMCPServerConditions(filters);

      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      const order = Object.entries(filters?.sort ?? {}).flatMap(([field, direction]) => {
        const column = MCP_SERVER_SORT_COLUMNS[field as keyof typeof MCP_SERVER_SORT_COLUMNS];
        return column ? [direction === -1 ? desc(column) : asc(column)] : [];
      });
      query = query.orderBy(...order, asc(mcpServers.mcp_server_id));
      if (filters?.limit !== undefined) {
        query = query.limit(Math.max(0, Math.min(PAGINATION.MAX_LIMIT, Math.trunc(filters.limit))));
      }
      if (filters?.offset !== undefined) {
        query = query.offset(Math.max(0, Math.trunc(filters.offset)));
      }

      const rows = await query.all();
      return rows.map((row: MCPServerRow) => this.rowToMCPServer(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update MCP server by ID
   */
  async update(
    id: string,
    updates: UpdateMCPServerInput,
    options: MCPServerUpdateOptions = {}
  ): Promise<MCPServer> {
    try {
      const fullId = await this.resolveId(id);
      const mutate = () =>
        runWithTenantDatabaseTransaction(this.db, undefined, async (tx) => {
          const where = eq(mcpServers.mcp_server_id, fullId);
          await lockRowForUpdate(tx, this.db, mcpServers, where);
          const row = await select(tx).from(mcpServers).where(where).one();
          if (!row) throw new EntityNotFoundError('MCPServer', id);
          assertStoredMCPConfigVersionCanAdvance(row.data.config_version);
          const current = this.rowToMCPServer(row as MCPServerRow);

          const { expected_config_version: expectedConfigVersion, replace_auth: replaceAuth } =
            updates;
          if (replaceAuth && !('auth' in updates)) {
            throw new Error('replace_auth requires an auth value');
          }
          const nextConfigVersion = nextMCPConfigVersion(current, expectedConfigVersion);
          const merged = mergeServerConfiguration(current, updates, nextConfigVersion, options);
          const insertData = this.mcpServerToInsert(merged, {
            preserveDaemonRevisions: true,
          });

          await update(tx, mcpServers)
            .set({
              enabled: insertData.enabled,
              scope: insertData.scope,
              transport: insertData.transport,
              catalog_entry_name: insertData.catalog_entry_name,
              updated_at: new Date(),
              data: insertData.data,
            })
            .where(where)
            .run();

          const updated = await select(tx).from(mcpServers).where(where).one();
          if (!updated) throw new RepositoryError('Failed to retrieve updated MCP server');
          return this.rowToMCPServer(updated as MCPServerRow);
        });

      // This method is the whole-row merge used by discovery and ordinary
      // patches. Retrying SQLite transaction admission lets it serialize with
      // the one-tool JSON mutation rather than surfacing a transient busy
      // error or falling back to the old read/overwrite race.
      for (let attempt = 0; ; attempt++) {
        try {
          return await mutate();
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (
            !isSQLiteDatabase(this.db) ||
            !/SQLITE_BUSY|database is locked|database is busy/i.test(text) ||
            attempt >= 9
          ) {
            throw error;
          }
          await waitForSQLiteBusyRetry('configuration update', attempt);
        }
      }
    } catch (error) {
      if (
        error instanceof RepositoryError ||
        error instanceof MCPAuthValidationError ||
        error instanceof MCPServerWriteValidationError
      ) {
        throw error;
      }
      if (error instanceof EntityNotFoundError || error instanceof MCPServerConfigConflictError) {
        throw error;
      }
      throw new RepositoryError(
        `Failed to update MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Apply a catalog reconnect only if it is still the newest request begun for
   * this tenant/owner/catalog identity. The generation row is locked through
   * the credential update, so a newer request cannot claim its generation
   * between the check and the write.
   */
  async updateIfCatalogConnectGeneration(
    id: string,
    ownerUserId: string,
    catalogEntryName: string,
    expectedGeneration: number,
    updates: UpdateMCPServerInput
  ): Promise<MCPServer | null> {
    const fullId = await this.resolveId(id);
    const key = MCPServerRepository.catalogConnectGenerationKey(ownerUserId, catalogEntryName);
    const mutate = () =>
      runWithTenantDatabaseTransaction(this.db, undefined, async (tx) => {
        const generationWhere = and(
          eq(appVariables.namespace, MCPServerRepository.CATALOG_CONNECT_GENERATION_NAMESPACE),
          eq(appVariables.key, key)
        );
        await lockRowForUpdate(tx, this.db, appVariables, generationWhere!);
        const generationRow = await select(tx).from(appVariables).where(generationWhere).one();
        if (Number(generationRow?.value_text) !== expectedGeneration) return null;

        await lockRowForUpdate(tx, this.db, mcpServers, eq(mcpServers.mcp_server_id, fullId));
        const row = await select(tx)
          .from(mcpServers)
          .where(eq(mcpServers.mcp_server_id, fullId))
          .one();
        if (!row) throw new EntityNotFoundError('MCPServer', id);
        assertStoredMCPConfigVersionCanAdvance(row.data.config_version);
        const current = this.rowToMCPServer(row as MCPServerRow);
        if (
          current.source !== 'catalog' ||
          current.owner_user_id !== ownerUserId ||
          current.catalog_entry_name !== catalogEntryName
        ) {
          throw new RepositoryError('Catalog connect generation does not match the install');
        }
        const { expected_config_version: expectedConfigVersion, replace_auth: replaceAuth } =
          updates;
        if (replaceAuth && !('auth' in updates)) {
          throw new Error('replace_auth requires an auth value');
        }
        const nextConfigVersion = nextMCPConfigVersion(current, expectedConfigVersion);
        const merged = mergeServerConfiguration(current, updates, nextConfigVersion, {});
        const insertData = this.mcpServerToInsert(merged, {
          preserveDaemonRevisions: true,
        });
        await update(tx, mcpServers)
          .set({
            enabled: insertData.enabled,
            scope: insertData.scope,
            transport: insertData.transport,
            catalog_entry_name: insertData.catalog_entry_name,
            updated_at: new Date(),
            data: insertData.data,
          })
          .where(eq(mcpServers.mcp_server_id, fullId))
          .run();
        const updated = await select(tx)
          .from(mcpServers)
          .where(eq(mcpServers.mcp_server_id, fullId))
          .one();
        if (!updated) throw new RepositoryError('Failed to retrieve updated MCP server');
        return this.rowToMCPServer(updated as MCPServerRow);
      });

    // A pair of first-connects deliberately contend on this transaction. On
    // SQLite, BEGIN IMMEDIATE can report SQLITE_BUSY instead of honoring the
    // configured busy timeout. Retry admission, then re-check the generation
    // under the lock: the older request deterministically becomes `null`
    // rather than leaking a storage-engine error through Connect.
    for (let attempt = 0; ; attempt++) {
      try {
        return await mutate();
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (
          !isSQLiteDatabase(this.db) ||
          !/SQLITE_BUSY|database is locked|database is busy/i.test(text) ||
          attempt >= 9
        ) {
          throw error;
        }
        await waitForSQLiteBusyRetry('catalog credential update', attempt);
      }
    }
  }

  /**
   * Delete MCP server by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, mcpServers)
        .where(eq(mcpServers.mcp_server_id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('MCPServer', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete an install only while no session has adopted it.
   *
   * Serialize cleanup against attachment through the parent row. PostgreSQL
   * attachment inserts take a foreign-key key-share lock on that row. Taking
   * FOR UPDATE here therefore waits for an already-running adoption, and the
   * following SELECT is a new READ COMMITTED statement with a fresh snapshot.
   * This ordering matters: a single DELETE ... NOT EXISTS statement takes its
   * snapshot before a lock wait and can miss the attachment that just committed.
   *
   * SQLite starts an IMMEDIATE transaction instead. That acquires the writer
   * reservation before the liveness read, so an attachment either commits
   * first and is observed or starts only after cleanup has completed.
   */
  async deleteIfUnattached(
    id: string,
    generation?: { ownerUserId: string; catalogEntryName: string; value: number }
  ): Promise<boolean> {
    try {
      const fullId = await this.resolveId(id);
      const mutate = () =>
        runDatabaseTransaction(
          this.db,
          (tx) =>
            new MCPServerRepository(tx).deleteIfUnattachedInCurrentTransaction(fullId, generation),
          { sqliteImmediate: true }
        );
      for (let attempt = 0; ; attempt++) {
        try {
          return await mutate();
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (
            !isSQLiteDatabase(this.db) ||
            !/SQLITE_BUSY|database is locked|database is busy/i.test(text) ||
            attempt >= 9
          ) {
            throw error;
          }
          // Re-running the transaction is safe: the attachment liveness and
          // optional connect generation are both re-read after admission.
          await new Promise((resolve) => setTimeout(resolve, Math.min(5 * 2 ** attempt, 100)));
        }
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) return false;
      throw new RepositoryError(
        `Failed to delete unattached MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Transaction-body variant used when caller authority and this mutation are
   * one atomic unit. It deliberately opens no nested transaction, which keeps
   * libsql `:memory:` and runtime SQLite on the same transaction connection.
   */
  async deleteIfUnattachedInCurrentTransaction(
    id: string,
    generation?: { ownerUserId: string; catalogEntryName: string; value: number }
  ): Promise<boolean> {
    const fullId = await this.resolveId(id);
    if (generation) {
      const generationWhere = and(
        eq(appVariables.namespace, MCPServerRepository.CATALOG_CONNECT_GENERATION_NAMESPACE),
        eq(
          appVariables.key,
          MCPServerRepository.catalogConnectGenerationKey(
            generation.ownerUserId,
            generation.catalogEntryName
          )
        )
      );
      await lockRowForUpdate(this.db, this.db, appVariables, generationWhere!);
      const generationRow = await select(this.db).from(appVariables).where(generationWhere).one();
      if (Number(generationRow?.value_text) !== generation.value) return false;
    }
    const where = eq(mcpServers.mcp_server_id, fullId);
    await lockRowForUpdate(this.db, this.db, mcpServers, where);
    const attachment = await select(this.db)
      .from(sessionMcpServers)
      .where(eq(sessionMcpServers.mcp_server_id, fullId))
      .limit(1)
      .one();
    if (attachment) return false;
    const result = await deleteFrom(this.db, mcpServers).where(where).run();
    return result.rowsAffected > 0;
  }

  /** Materialized-column ownership read; never loads the secret-bearing JSON blob. */
  async isOwnedBy(id: string, ownerUserId: UserID): Promise<boolean> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db, { id: mcpServers.mcp_server_id })
        .from(mcpServers)
        .where(and(eq(mcpServers.mcp_server_id, fullId), eq(mcpServers.owner_user_id, ownerUserId)))
        .one();
      return Boolean(row);
    } catch (error) {
      if (error instanceof EntityNotFoundError) return false;
      throw new RepositoryError(
        `Failed to check MCP server ownership: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Atomically change exactly one tool policy after an authoritative service
   * has decided who may mutate the row.
   *
   * Discovery and ordinary patches take the same row lock, so neither can
   * overwrite a concurrent per-tool decision with a stale whole JSON object.
   * The row-locked update preserves undiscovered rules, explicit Ask rules,
   * and another concurrent toggle while advancing the editor CAS revision.
   */
  async setToolEnabled(
    id: string,
    toolName: string,
    enabled: boolean,
    ownerUserId?: UserID
  ): Promise<boolean> {
    try {
      const fullId = await this.resolveId(id);
      const mutate = () =>
        runDatabaseTransaction(
          this.db,
          (tx) =>
            new MCPServerRepository(tx).setToolEnabledInCurrentTransaction(
              fullId,
              toolName,
              enabled,
              ownerUserId
            ),
          { sqliteImmediate: true }
        );
      // libsql can reject one of two simultaneous BEGIN IMMEDIATE calls
      // before its configured busy timeout takes effect. Retry only that
      // transient admission failure; the SQL mutation remains one atomic unit.
      for (let attempt = 0; ; attempt++) {
        try {
          return await mutate();
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (
            !isSQLiteDatabase(this.db) ||
            !/SQLITE_BUSY|database is locked|database is busy/i.test(text) ||
            attempt >= 9
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(5 * 2 ** attempt, 100)));
        }
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) return false;
      throw new RepositoryError(
        `Failed to change MCP tool permission: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** No nested transaction; see {@link deleteIfUnattachedInCurrentTransaction}. */
  async setToolEnabledInCurrentTransaction(
    id: string,
    toolName: string,
    enabled: boolean,
    ownerUserId?: UserID
  ): Promise<boolean> {
    const fullId = await this.resolveId(id);
    const target = ownerUserId
      ? and(eq(mcpServers.mcp_server_id, fullId), eq(mcpServers.owner_user_id, ownerUserId))!
      : eq(mcpServers.mcp_server_id, fullId);
    await lockRowForUpdate(this.db, this.db, mcpServers, target);
    const row = await select(this.db).from(mcpServers).where(target).one();
    if (!row) return false;
    assertStoredMCPConfigVersionCanAdvance(row.data.config_version);
    const current = this.rowToMCPServer(row as MCPServerRow);
    const version = current.config_version ?? 1;
    if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER - 1) {
      throw new RepositoryError('MCP server configuration revision is invalid or exhausted');
    }
    const sqlitePath = `$."tool_permissions"."${toolName
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')}"`;
    const nextPermissions = isPostgresDatabase(this.db)
      ? enabled
        ? sql`jsonb_set(${mcpServers.data}, '{tool_permissions}'::text[], coalesce(${mcpServers.data}->'tool_permissions', '{}'::jsonb) - ${toolName}::text, true)`
        : sql`jsonb_set(${mcpServers.data}, '{tool_permissions}'::text[], coalesce(${mcpServers.data}->'tool_permissions', '{}'::jsonb) || jsonb_build_object(${toolName}::text, 'deny'), true)`
      : enabled
        ? sql`json_remove(${mcpServers.data}, ${sqlitePath})`
        : sql`json_set(${mcpServers.data}, ${sqlitePath}, ${'deny'})`;
    // Keep the repaired dialect-specific in-place JSON mutation so a tool
    // permission edit cannot overwrite unrelated current configuration. The
    // daemon-owned revision is advanced in that same statement.
    const nextData = isPostgresDatabase(this.db)
      ? sql`jsonb_set(${nextPermissions}, '{config_version}'::text[], to_jsonb(${version + 1}::bigint), true)`
      : sql`json_set(${nextPermissions}, '$.config_version', ${version + 1})`;
    const result = await update(this.db, mcpServers)
      .set({ data: nextData, updated_at: new Date() })
      .where(target)
      .run();
    return result.rowsAffected > 0;
  }

  /**
   * Persist exactly the three provider-reported capability lists.
   *
   * The caller must already hold the server row lock and must have rechecked
   * its discovery configuration. Editing the JSON expression in place avoids
   * replacing auth, endpoint configuration, or a concurrent per-tool rule
   * with an object captured before the network request.
   */
  async setDiscoveredCapabilitiesInCurrentTransaction(
    id: string,
    capabilities: Pick<MCPServer, 'tools' | 'resources' | 'prompts'>
  ): Promise<boolean> {
    const fullId = await this.resolveId(id);
    const where = eq(mcpServers.mcp_server_id, fullId);
    const toolsJson = JSON.stringify(capabilities.tools ?? []);
    const resourcesJson = JSON.stringify(capabilities.resources ?? []);
    const promptsJson = JSON.stringify(capabilities.prompts ?? []);
    const nextData = isPostgresDatabase(this.db)
      ? sql`jsonb_set(jsonb_set(jsonb_set(${mcpServers.data}, '{tools}'::text[], ${toolsJson}::jsonb, true), '{resources}'::text[], ${resourcesJson}::jsonb, true), '{prompts}'::text[], ${promptsJson}::jsonb, true)`
      : sql`json_set(${mcpServers.data}, '$.tools', json(${toolsJson}), '$.resources', json(${resourcesJson}), '$.prompts', json(${promptsJson}))`;
    const result = await update(this.db, mcpServers)
      .set({ data: nextData, updated_at: new Date() })
      .where(where)
      .run();
    return result.rowsAffected > 0;
  }

  /** Backwards-compatible owner-CAS primitive for trusted repository callers. */
  async setOwnedToolEnabled(
    id: string,
    ownerUserId: UserID,
    toolName: string,
    enabled: boolean
  ): Promise<boolean> {
    return this.setToolEnabled(id, toolName, enabled, ownerUserId);
  }

  /**
   * Count total MCP servers
   */
  async count(filters?: MCPServerFilters): Promise<number> {
    try {
      const conditions = buildMCPServerConditions(filters);

      const query = select(this.db, { count: sql<number>`count(*)` }).from(mcpServers);
      const row = await (conditions.length > 0 ? query.where(and(...conditions)) : query).one();
      return Number(row?.count ?? 0);
    } catch (error) {
      throw new RepositoryError(
        `Failed to count MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
