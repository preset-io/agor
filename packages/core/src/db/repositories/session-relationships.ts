/**
 * Session Relationship Repository
 *
 * Durable cross-session links that are not necessarily canonical genealogy.
 */

import type {
  SessionID,
  SessionRelationship,
  SessionRelationshipID,
  SessionRelationshipType,
  UserID,
} from '@agor/core/types';
import { and, eq, inArray, or } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { insert, select, update } from '../database-wrapper';
import {
  type SessionRelationshipInsert,
  type SessionRelationshipRow,
  sessionRelationships,
} from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';

export interface CreateSessionRelationshipInput {
  source_session_id: SessionID;
  target_session_id: SessionID;
  relationship_type: SessionRelationshipType;
  created_by: UserID;
  callback_enabled?: boolean;
  callback_session_id?: SessionID | null;
  data?: Record<string, unknown> | null;
}

export class SessionRelationshipRepository {
  constructor(private db: Database) {}

  private rowToRelationship(row: SessionRelationshipRow): SessionRelationship {
    return {
      relationship_id: row.relationship_id as SessionRelationshipID,
      source_session_id: row.source_session_id as SessionID,
      target_session_id: row.target_session_id as SessionID,
      relationship_type: row.relationship_type as SessionRelationshipType,
      created_by: row.created_by as UserID,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      callback_enabled: Boolean(row.callback_enabled),
      callback_session_id: (row.callback_session_id as SessionID | null) ?? null,
      data: row.data ?? null,
    };
  }

  async create(input: CreateSessionRelationshipInput): Promise<SessionRelationship> {
    try {
      const now = new Date();
      const row: SessionRelationshipInsert = {
        relationship_id: generateId() as SessionRelationshipID,
        source_session_id: input.source_session_id,
        target_session_id: input.target_session_id,
        relationship_type: input.relationship_type,
        created_by: input.created_by,
        created_at: now,
        updated_at: now,
        callback_enabled: input.callback_enabled ?? false,
        callback_session_id: input.callback_session_id ?? null,
        data: input.data ?? null,
      };

      await insert(this.db, sessionRelationships).values(row).run();
      return this.rowToRelationship(row as SessionRelationshipRow);
    } catch (error) {
      throw new RepositoryError(
        `Failed to create session relationship: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async get(relationshipId: SessionRelationshipID): Promise<SessionRelationship> {
    try {
      const row = await select(this.db)
        .from(sessionRelationships)
        .where(eq(sessionRelationships.relationship_id, relationshipId))
        .one();
      if (!row) throw new EntityNotFoundError('SessionRelationship', relationshipId);
      return this.rowToRelationship(row);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to get session relationship: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findForSession(sessionId: SessionID): Promise<SessionRelationship[]> {
    try {
      const rows = await select(this.db)
        .from(sessionRelationships)
        .where(
          or(
            eq(sessionRelationships.source_session_id, sessionId),
            eq(sessionRelationships.target_session_id, sessionId)
          )
        )
        .all();
      return rows.map((row: SessionRelationshipRow) => this.rowToRelationship(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list session relationships: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findForSessions(sessionIds: SessionID[]): Promise<SessionRelationship[]> {
    if (sessionIds.length === 0) return [];

    try {
      const rows = await select(this.db)
        .from(sessionRelationships)
        .where(
          or(
            inArray(sessionRelationships.source_session_id, sessionIds),
            inArray(sessionRelationships.target_session_id, sessionIds)
          )
        )
        .all();
      return rows.map((row: SessionRelationshipRow) => this.rowToRelationship(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list session relationships: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findRemoteChildren(sourceSessionId: SessionID): Promise<SessionRelationship[]> {
    try {
      const rows = await select(this.db)
        .from(sessionRelationships)
        .where(
          and(
            eq(sessionRelationships.source_session_id, sourceSessionId),
            eq(sessionRelationships.relationship_type, 'remote_create')
          )
        )
        .all();
      return rows.map((row: SessionRelationshipRow) => this.rowToRelationship(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list remote child relationships: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findRemoteParents(targetSessionId: SessionID): Promise<SessionRelationship[]> {
    try {
      const rows = await select(this.db)
        .from(sessionRelationships)
        .where(
          and(
            eq(sessionRelationships.target_session_id, targetSessionId),
            eq(sessionRelationships.relationship_type, 'remote_create')
          )
        )
        .all();
      return rows.map((row: SessionRelationshipRow) => this.rowToRelationship(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list remote parent relationships: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async setCallbackEnabled(
    relationshipId: SessionRelationshipID,
    callbackEnabled: boolean
  ): Promise<SessionRelationship> {
    try {
      const result = await update(this.db, sessionRelationships)
        .set({ callback_enabled: callbackEnabled, updated_at: new Date() })
        .where(eq(sessionRelationships.relationship_id, relationshipId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('SessionRelationship', relationshipId);
      }

      const row = await select(this.db)
        .from(sessionRelationships)
        .where(eq(sessionRelationships.relationship_id, relationshipId))
        .one();
      if (!row) throw new EntityNotFoundError('SessionRelationship', relationshipId);
      return this.rowToRelationship(row);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update session relationship callback state: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async setCallbackEnabledForTargetSession(
    targetSessionId: SessionID,
    callbackEnabled: boolean
  ): Promise<void> {
    try {
      await update(this.db, sessionRelationships)
        .set({ callback_enabled: callbackEnabled, updated_at: new Date() })
        .where(
          and(
            eq(sessionRelationships.target_session_id, targetSessionId),
            eq(sessionRelationships.relationship_type, 'remote_create')
          )
        )
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to update target session relationship callback state: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
