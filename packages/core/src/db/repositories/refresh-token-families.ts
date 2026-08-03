import { createHash } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteFrom, insert, runDatabaseTransaction, update } from '../database-wrapper';
import { refreshTokenFamilies } from '../schema';

export const hashRefreshTokenId = (tokenId: string): string =>
  createHash('sha256').update(tokenId).digest('hex');

export class RefreshTokenFamiliesRepository {
  constructor(private db: Database) {}

  async create(input: {
    familyId: string;
    tenantId: string;
    userId: string;
    tokenId: string;
    expiresAt: Date;
  }) {
    void input.tenantId; // PostgreSQL ownership is enforced by ambient tenant RLS.
    await insert(this.db, refreshTokenFamilies)
      .values({
        family_id: input.familyId,
        user_id: input.userId,
        current_token_hash: hashRefreshTokenId(input.tokenId),
        created_at: new Date(),
        expires_at: input.expiresAt,
      })
      .run();
  }

  /** Atomically consume the current token. A miss means replay/concurrent use. */
  async rotate(input: {
    familyId: string;
    tenantId: string;
    userId: string;
    tokenId: string;
    nextTokenId: string;
  }): Promise<boolean> {
    void input.tenantId;
    const attempt = () =>
      runDatabaseTransaction(
        this.db,
        async (tx) => {
          const result = await update(tx, refreshTokenFamilies)
            .set({ current_token_hash: hashRefreshTokenId(input.nextTokenId) })
            .where(
              and(
                eq(refreshTokenFamilies.family_id, input.familyId),
                eq(refreshTokenFamilies.user_id, input.userId),
                eq(refreshTokenFamilies.current_token_hash, hashRefreshTokenId(input.tokenId)),
                isNull(refreshTokenFamilies.revoked_at)
              )
            )
            .run();
          if (result.rowsAffected === 1) return true;
          await update(tx, refreshTokenFamilies)
            .set({ revoked_at: new Date() })
            .where(
              and(
                eq(refreshTokenFamilies.family_id, input.familyId),
                eq(refreshTokenFamilies.user_id, input.userId)
              )
            )
            .run();
          return false;
        },
        { sqliteImmediate: true }
      );
    for (let retry = 0; ; retry += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (retry >= 4 || !(error instanceof Error) || !error.message.includes('SQLITE_BUSY'))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (retry + 1)));
      }
    }
  }

  async revokeFamily(familyId: string, tenantId: string, userId: string): Promise<void> {
    void tenantId;
    await update(this.db, refreshTokenFamilies)
      .set({ revoked_at: new Date() })
      .where(
        and(eq(refreshTokenFamilies.family_id, familyId), eq(refreshTokenFamilies.user_id, userId))
      )
      .run();
  }

  async revokeAll(userId: string, tenantId: string): Promise<void> {
    void tenantId;
    await update(this.db, refreshTokenFamilies)
      .set({ revoked_at: new Date() })
      .where(and(eq(refreshTokenFamilies.user_id, userId), isNull(refreshTokenFamilies.revoked_at)))
      .run();
  }

  async deleteExpired(now = new Date()): Promise<void> {
    await deleteFrom(this.db, refreshTokenFamilies)
      .where(lt(refreshTokenFamilies.expires_at, now))
      .run();
  }
}
