import type { UserID } from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import { type AppVariableInsert, type AppVariableRow, appVariables } from '../schema';
import { RepositoryError } from './base';

export interface AppVariable {
  variable_id: string;
  namespace: string;
  key: string;
  value_text?: string | null;
  value_encrypted?: string | null;
  is_encrypted: boolean;
  content_type: string;
  metadata?: Record<string, unknown> | null;
  updated_by?: UserID | null;
  created_at: Date;
  updated_at: Date;
}

export interface SetAppVariableInput {
  namespace: string;
  key: string;
  value: string | null;
  encrypted?: boolean;
  content_type?: string;
  metadata?: Record<string, unknown> | null;
  updated_by?: UserID | null;
}

export class AppVariableRepository {
  constructor(private db: Database) {}

  rowToVariable(row: AppVariableRow): AppVariable {
    return {
      variable_id: row.variable_id,
      namespace: row.namespace,
      key: row.key,
      value_text: row.value_text ?? null,
      value_encrypted: row.value_encrypted ?? null,
      is_encrypted: Boolean(row.is_encrypted),
      content_type: row.content_type,
      metadata: row.metadata ?? null,
      updated_by: (row.updated_by as UserID | null) ?? null,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  async find(namespace: string, key: string): Promise<AppVariable | null> {
    const row = await select(this.db)
      .from(appVariables)
      .where(and(eq(appVariables.namespace, namespace), eq(appVariables.key, key)))
      .one();
    return row ? this.rowToVariable(row as AppVariableRow) : null;
  }

  async getPlain(namespace: string, key: string): Promise<string | null> {
    const variable = await this.find(namespace, key);
    if (!variable) return null;
    if (!variable.is_encrypted) return variable.value_text ?? null;
    if (!variable.value_encrypted) return null;
    try {
      return decryptApiKey(variable.value_encrypted);
    } catch (error) {
      throw new RepositoryError(
        `Failed to decrypt app variable ${namespace}.${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
  }

  async set(data: SetAppVariableInput): Promise<AppVariable> {
    const now = new Date();
    const encrypted = data.encrypted === true;
    let valueText: string | null = data.value;
    let valueEncrypted: string | null = null;
    if (encrypted && data.value !== null) {
      valueEncrypted = encryptApiKey(data.value);
      valueText = null;
    }

    const existing = await this.find(data.namespace, data.key);
    if (existing) {
      const row = await update(this.db, appVariables)
        .set({
          value_text: valueText,
          value_encrypted: valueEncrypted,
          is_encrypted: encrypted,
          content_type: data.content_type ?? existing.content_type,
          metadata: data.metadata ?? existing.metadata ?? null,
          updated_by: data.updated_by ?? null,
          updated_at: now,
        })
        .where(eq(appVariables.variable_id, existing.variable_id))
        .returning()
        .one();
      return this.rowToVariable(row as AppVariableRow);
    }

    const insertRow: AppVariableInsert = {
      variable_id: generateId(),
      namespace: data.namespace,
      key: data.key,
      value_text: valueText,
      value_encrypted: valueEncrypted,
      is_encrypted: encrypted,
      content_type: data.content_type ?? 'text/plain',
      metadata: data.metadata ?? null,
      updated_by: data.updated_by ?? null,
      created_at: now,
      updated_at: now,
    };
    const row = await insert(this.db, appVariables).values(insertRow).returning().one();
    return this.rowToVariable(row as AppVariableRow);
  }

  /** Ensure a row exists without replacing a concurrent writer's value. */
  async setIfAbsent(data: SetAppVariableInput): Promise<void> {
    const now = new Date();
    const encrypted = data.encrypted === true;
    const insertRow: AppVariableInsert = {
      variable_id: generateId(),
      namespace: data.namespace,
      key: data.key,
      value_text: encrypted ? null : data.value,
      value_encrypted: encrypted && data.value !== null ? encryptApiKey(data.value) : null,
      is_encrypted: encrypted,
      content_type: data.content_type ?? 'text/plain',
      metadata: data.metadata ?? null,
      updated_by: data.updated_by ?? null,
      created_at: now,
      updated_at: now,
    };
    await insert(this.db, appVariables).values(insertRow).onConflictDoNothing().run();
  }

  async setEncrypted(
    namespace: string,
    key: string,
    value: string | null,
    updatedBy?: UserID | null
  ): Promise<AppVariable> {
    return this.set({ namespace, key, value, encrypted: true, updated_by: updatedBy ?? null });
  }

  async delete(namespace: string, key: string): Promise<void> {
    await deleteFrom(this.db, appVariables)
      .where(and(eq(appVariables.namespace, namespace), eq(appVariables.key, key)))
      .run();
  }
}
