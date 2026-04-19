/**
 * MCP Token Revocation Repository
 *
 * Thin persistence layer over the `mcp_token_revocations` ledger.
 * The daemon's `mcp/tokens.ts` module owns the business logic (cache, JWT
 * signing, generation-bump bulk revoke); this repository owns the SQL.
 */

import type { MCPTokenRevocationReason, SessionID } from '@agor/core/types';
import { gt, lte } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteFrom, insert, select } from '../database-wrapper';
import { type MCPTokenRevocationRow, mcpTokenRevocations } from '../schema';
import { RepositoryError } from './base';

export interface McpTokenRevocationInsertInput {
  jti: string;
  session_id: SessionID | null;
  revoked_at: number;
  revoked_by: string | null;
  reason: MCPTokenRevocationReason;
  expires_at: number;
}

export class McpTokenRevocationRepository {
  constructor(private db: Database) {}

  /**
   * Insert a revocation row; idempotent — replaying the same `jti` is a no-op
   * via `onConflictDoNothing`, so callers can safely retry without duplicate
   * entries or PK violations.
   */
  async insertIgnore(values: McpTokenRevocationInsertInput): Promise<void> {
    try {
      await insert(this.db, mcpTokenRevocations).values(values).onConflictDoNothing().run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to insert MCP token revocation: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * List non-expired revocations (for the audit/list REST endpoint).
   * SQL-filters on the `expires_at` index so expired rows never cross the wire.
   */
  async listActive(nowMs: number): Promise<MCPTokenRevocationRow[]> {
    try {
      return (await select(this.db)
        .from(mcpTokenRevocations)
        .where(gt(mcpTokenRevocations.expires_at, nowMs))
        .all()) as MCPTokenRevocationRow[];
    } catch (error) {
      throw new RepositoryError(
        `Failed to list active MCP token revocations: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete rows whose `expires_at` has already passed. The token's own JWT
   * `exp` claim has already rejected them, so the ledger row is redundant.
   * Returns the number of rows deleted.
   */
  async deleteExpired(nowMs: number): Promise<number> {
    try {
      const res = await deleteFrom(this.db, mcpTokenRevocations)
        .where(lte(mcpTokenRevocations.expires_at, nowMs))
        .run();
      return res?.rowsAffected ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to delete expired MCP token revocations: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Return just the `jti` values of non-expired rows — used to seed the
   * daemon's in-process revocation cache at startup and after cleanup runs.
   */
  async listActiveJtis(nowMs: number): Promise<string[]> {
    const rows = await this.listActive(nowMs);
    return rows.map((r) => r.jti);
  }
}
