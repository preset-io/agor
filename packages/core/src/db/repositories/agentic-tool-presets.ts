import { and, asc, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type {
  AgenticToolPreset,
  AgenticToolPresetID,
  CreateAgenticToolPreset,
  PatchAgenticToolPreset,
  TenantAgenticToolName,
  UserID,
} from '../../types';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  type AgenticToolPresetInsert,
  type AgenticToolPresetRow,
  agenticToolPresets,
} from '../schema';
import { attachHiddenTenant, EntityNotFoundError, RepositoryError } from './base';

function rowToPreset(row: AgenticToolPresetRow): AgenticToolPreset {
  const configuration =
    typeof row.configuration === 'string' ? JSON.parse(row.configuration) : row.configuration;
  return attachHiddenTenant(
    {
      preset_id: row.preset_id as AgenticToolPresetID,
      tool: row.tool as TenantAgenticToolName,
      name: row.name,
      description: row.description ?? undefined,
      is_default: Boolean(row.is_default),
      configuration: configuration as AgenticToolPreset['configuration'],
      created_by: row.created_by as UserID,
      updated_by: row.updated_by as UserID,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    },
    row
  );
}

/** Tenant scoping is supplied by the ambient database wrapper. */
export class AgenticToolPresetRepository {
  constructor(private db: Database) {}

  async find(tool?: TenantAgenticToolName): Promise<AgenticToolPreset[]> {
    const query = select(this.db).from(agenticToolPresets);
    const rows = tool
      ? await query
          .where(eq(agenticToolPresets.tool, tool))
          .orderBy(asc(agenticToolPresets.name))
          .all()
      : await query.orderBy(asc(agenticToolPresets.tool), asc(agenticToolPresets.name)).all();
    return rows.map(rowToPreset);
  }

  async findById(id: AgenticToolPresetID | string): Promise<AgenticToolPreset | null> {
    const row = await select(this.db)
      .from(agenticToolPresets)
      .where(eq(agenticToolPresets.preset_id, id))
      .one();
    return row ? rowToPreset(row) : null;
  }

  async findDefault(tool: TenantAgenticToolName): Promise<AgenticToolPreset | null> {
    const row = await select(this.db)
      .from(agenticToolPresets)
      .where(and(eq(agenticToolPresets.tool, tool), eq(agenticToolPresets.is_default, true)))
      .one();
    return row ? rowToPreset(row) : null;
  }

  async create(data: CreateAgenticToolPreset, actor: UserID): Promise<AgenticToolPreset> {
    const now = new Date();
    const name = data.name.trim();
    if (!name) throw new RepositoryError('Preset name is required');
    const values: AgenticToolPresetInsert = {
      preset_id: generateId(),
      tool: data.tool,
      name,
      description: data.description?.trim() || null,
      is_default: data.is_default ?? false,
      configuration: data.configuration,
      created_by: actor,
      updated_by: actor,
      created_at: now,
      updated_at: now,
    };
    try {
      return await runDatabaseTransaction(
        this.db,
        async (db) => {
          if (data.is_default) {
            await update(db, agenticToolPresets)
              .set({ is_default: false })
              .where(eq(agenticToolPresets.tool, data.tool))
              .run();
          }
          return rowToPreset(await insert(db, agenticToolPresets).values(values).returning().one());
        },
        { sqliteImmediate: true }
      );
    } catch (error) {
      throw new RepositoryError(`Failed to create preset '${name}': ${String(error)}`, error);
    }
  }

  async patch(
    id: AgenticToolPresetID | string,
    data: PatchAgenticToolPreset,
    actor: UserID
  ): Promise<AgenticToolPreset> {
    return runDatabaseTransaction(this.db, async (db) => {
      await lockRowForUpdate(db, this.db, agenticToolPresets, eq(agenticToolPresets.preset_id, id));
      const currentRow = await select(db)
        .from(agenticToolPresets)
        .where(eq(agenticToolPresets.preset_id, id))
        .one();
      if (!currentRow) throw new EntityNotFoundError('AgenticToolPreset', id);
      const current = rowToPreset(currentRow);
      if (data.is_default) {
        await update(db, agenticToolPresets)
          .set({ is_default: false })
          .where(eq(agenticToolPresets.tool, current.tool))
          .run();
      }
      const row = await update(db, agenticToolPresets)
        .set({
          ...(data.name !== undefined ? { name: data.name.trim() } : {}),
          ...(data.description !== undefined
            ? { description: data.description.trim() || null }
            : {}),
          ...(data.configuration !== undefined ? { configuration: data.configuration } : {}),
          ...(data.is_default !== undefined ? { is_default: data.is_default } : {}),
          updated_by: actor,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agenticToolPresets.preset_id, current.preset_id),
            eq(agenticToolPresets.tool, current.tool)
          )
        )
        .returning()
        .one();
      return rowToPreset(row);
    });
  }

  async remove(id: AgenticToolPresetID | string): Promise<AgenticToolPreset> {
    const current = await this.findById(id);
    if (!current) throw new EntityNotFoundError('AgenticToolPreset', id);
    await deleteFrom(this.db, agenticToolPresets)
      .where(eq(agenticToolPresets.preset_id, current.preset_id))
      .run();
    return current;
  }
}
