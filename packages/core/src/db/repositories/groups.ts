/**
 * Group Repository
 *
 * Type-safe CRUD for admin-managed user groups, memberships, and branch group grants.
 */

import type {
  BoardGroupGrant,
  BoardGroupGrantWithGroup,
  BoardID,
  BranchGroupGrant,
  BranchGroupGrantWithGroup,
  BranchID,
  BranchPermissionLevel,
  Group,
  GroupID,
  GroupMembership,
  UserID,
} from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  type BoardGroupGrantRow,
  type BranchGroupGrantRow,
  boardGroupGrants,
  branchGroupGrants,
  type GroupInsert,
  type GroupMembershipRow,
  type GroupRow,
  groupMemberships,
  groups,
} from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';

export interface CreateGroupInput {
  name: string;
  slug?: string;
  description?: string | null;
  created_by?: UserID;
}

export interface UpdateGroupInput {
  name?: string;
  slug?: string;
  description?: string | null;
  archived?: boolean;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeSlug(name: string, slug?: string): string {
  const normalized = slugify(slug || name);
  if (!normalized) {
    throw new RepositoryError('Group slug must contain at least one alphanumeric character');
  }
  return normalized;
}

export class GroupRepository {
  constructor(private db: Database) {}

  private rowToGroup(row: GroupRow): Group {
    return {
      group_id: row.group_id as GroupID,
      name: row.name,
      slug: row.slug,
      description: row.description ?? undefined,
      archived: Boolean(row.archived),
      created_by: (row.created_by as UserID | null) ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
    };
  }

  private rowToMembership(row: GroupMembershipRow): GroupMembership {
    return {
      group_id: row.group_id as GroupID,
      user_id: row.user_id as UserID,
      added_by: (row.added_by as UserID | null) ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  private rowToGrant(row: BranchGroupGrantRow, group?: Group): BranchGroupGrantWithGroup {
    return {
      branch_id: row.branch_id as BranchID,
      group_id: row.group_id as GroupID,
      can: row.can as BranchPermissionLevel,
      fs_access: row.fs_access ?? undefined,
      created_by: (row.created_by as UserID | null) ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      group,
    };
  }

  private rowToBoardGrant(row: BoardGroupGrantRow, group?: Group): BoardGroupGrantWithGroup {
    return {
      board_id: row.board_id as BoardID,
      group_id: row.group_id as GroupID,
      can: row.can as BranchPermissionLevel,
      fs_access: row.fs_access ?? undefined,
      created_by: (row.created_by as UserID | null) ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      group,
    };
  }

  async findAll(filter?: { archived?: boolean }): Promise<Group[]> {
    const conditions = [];
    if (filter?.archived !== undefined) conditions.push(eq(groups.archived, filter.archived));
    const query = select(this.db).from(groups);
    const rows =
      conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();
    return rows.map((row: GroupRow) => this.rowToGroup(row));
  }

  async findById(id: string): Promise<Group | null> {
    const row = await select(this.db).from(groups).where(eq(groups.group_id, id)).one();
    return row ? this.rowToGroup(row as GroupRow) : null;
  }

  async findBySlug(slug: string): Promise<Group | null> {
    const row = await select(this.db).from(groups).where(eq(groups.slug, slug)).one();
    return row ? this.rowToGroup(row as GroupRow) : null;
  }

  async create(data: CreateGroupInput): Promise<Group> {
    const now = new Date();
    const group_id = generateId() as GroupID;
    const row: GroupInsert = {
      group_id,
      name: data.name.trim(),
      slug: normalizeSlug(data.name, data.slug),
      description: data.description ?? null,
      archived: false,
      created_by: data.created_by ?? null,
      created_at: now,
      updated_at: now,
    };
    if (!row.name) throw new RepositoryError('Group name is required');
    await insert(this.db, groups).values(row).run();
    const created = await this.findById(group_id);
    if (!created) throw new RepositoryError('Failed to retrieve created group');
    return created;
  }

  async update(id: string, updates: UpdateGroupInput): Promise<Group> {
    const existing = await this.findById(id);
    if (!existing) throw new EntityNotFoundError('Group', id);
    const patch: Partial<GroupInsert> = { updated_at: new Date() };
    if (updates.name !== undefined) {
      const name = updates.name.trim();
      if (!name) throw new RepositoryError('Group name is required');
      patch.name = name;
    }
    if (updates.slug !== undefined) patch.slug = normalizeSlug(updates.slug);
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.archived !== undefined) patch.archived = updates.archived;
    await update(this.db, groups).set(patch).where(eq(groups.group_id, existing.group_id)).run();
    const updatedGroup = await this.findById(existing.group_id);
    if (!updatedGroup) throw new RepositoryError('Failed to retrieve updated group');
    return updatedGroup;
  }

  async delete(id: string): Promise<Group> {
    const existing = await this.findById(id);
    if (!existing) throw new EntityNotFoundError('Group', id);
    await deleteFrom(this.db, groups).where(eq(groups.group_id, existing.group_id)).run();
    return existing;
  }

  async listMemberships(filter?: {
    group_id?: string;
    user_id?: string;
  }): Promise<GroupMembership[]> {
    const conditions = [];
    if (filter?.group_id) conditions.push(eq(groupMemberships.group_id, filter.group_id));
    if (filter?.user_id) conditions.push(eq(groupMemberships.user_id, filter.user_id));
    const query = select(this.db).from(groupMemberships);
    const rows =
      conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();
    return rows.map((row: GroupMembershipRow) => this.rowToMembership(row));
  }

  async addMember(groupId: string, userId: string, addedBy?: UserID): Promise<GroupMembership> {
    const existing = await select(this.db)
      .from(groupMemberships)
      .where(and(eq(groupMemberships.group_id, groupId), eq(groupMemberships.user_id, userId)))
      .one();
    if (existing) return this.rowToMembership(existing as GroupMembershipRow);

    const row = {
      group_id: groupId as GroupID,
      user_id: userId as UserID,
      added_by: addedBy ?? null,
      created_at: new Date(),
    };
    await insert(this.db, groupMemberships).values(row).run();
    return this.rowToMembership(row as GroupMembershipRow);
  }

  async removeMember(groupId: string, userId: string): Promise<GroupMembership | null> {
    const existing = await select(this.db)
      .from(groupMemberships)
      .where(and(eq(groupMemberships.group_id, groupId), eq(groupMemberships.user_id, userId)))
      .one();
    if (!existing) return null;
    await deleteFrom(this.db, groupMemberships)
      .where(and(eq(groupMemberships.group_id, groupId), eq(groupMemberships.user_id, userId)))
      .run();
    return this.rowToMembership(existing as GroupMembershipRow);
  }

  async getGroupIdsForUser(userId: string): Promise<GroupID[]> {
    const rows = await select(this.db, { group_id: groupMemberships.group_id })
      .from(groupMemberships)
      .where(eq(groupMemberships.user_id, userId))
      .all();
    return rows.map((r: { group_id: string }) => r.group_id as GroupID);
  }

  async listBranchGrants(branchId: string): Promise<BranchGroupGrantWithGroup[]> {
    const rows = await select(this.db)
      .from(branchGroupGrants)
      .leftJoin(groups, eq(branchGroupGrants.group_id, groups.group_id))
      .where(eq(branchGroupGrants.branch_id, branchId))
      .all();
    return rows.map((r: { branch_group_grants: BranchGroupGrantRow; groups?: GroupRow | null }) =>
      this.rowToGrant(r.branch_group_grants, r.groups ? this.rowToGroup(r.groups) : undefined)
    );
  }

  async upsertBranchGrant(data: {
    branch_id: string;
    group_id: string;
    can: BranchPermissionLevel;
    fs_access?: 'none' | 'read' | 'write' | null;
    created_by?: UserID;
  }): Promise<BranchGroupGrantWithGroup> {
    const now = new Date();
    const existing = await select(this.db)
      .from(branchGroupGrants)
      .where(
        and(
          eq(branchGroupGrants.branch_id, data.branch_id),
          eq(branchGroupGrants.group_id, data.group_id)
        )
      )
      .one();

    if (existing) {
      await update(this.db, branchGroupGrants)
        .set({ can: data.can, fs_access: data.fs_access ?? null, updated_at: now })
        .where(
          and(
            eq(branchGroupGrants.branch_id, data.branch_id),
            eq(branchGroupGrants.group_id, data.group_id)
          )
        )
        .run();
    } else {
      await insert(this.db, branchGroupGrants)
        .values({
          branch_id: data.branch_id as BranchID,
          group_id: data.group_id as GroupID,
          can: data.can,
          fs_access: data.fs_access ?? null,
          created_by: data.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .run();
    }

    const grants = await this.listBranchGrants(data.branch_id);
    const grant = grants.find((g) => g.group_id === data.group_id);
    if (!grant) throw new RepositoryError('Failed to retrieve branch group grant');
    return grant;
  }

  async removeBranchGrant(
    branchId: string,
    groupId: string
  ): Promise<BranchGroupGrantWithGroup | null> {
    const existing =
      (await this.listBranchGrants(branchId)).find((g) => g.group_id === groupId) ?? null;
    if (!existing) return null;
    await deleteFrom(this.db, branchGroupGrants)
      .where(
        and(eq(branchGroupGrants.branch_id, branchId), eq(branchGroupGrants.group_id, groupId))
      )
      .run();
    return existing;
  }

  async getBranchGrantsForUser(branchId: string, userId: string): Promise<BranchGroupGrant[]> {
    const rows = await select(this.db)
      .from(branchGroupGrants)
      .innerJoin(groupMemberships, eq(branchGroupGrants.group_id, groupMemberships.group_id))
      .innerJoin(groups, eq(groupMemberships.group_id, groups.group_id))
      .where(
        and(
          eq(branchGroupGrants.branch_id, branchId),
          eq(groupMemberships.user_id, userId),
          eq(groups.archived, false)
        )
      )
      .all();
    return rows.map((row: { branch_group_grants: BranchGroupGrantRow }) =>
      this.rowToGrant(row.branch_group_grants)
    );
  }

  async listBoardGrants(boardId: string): Promise<BoardGroupGrantWithGroup[]> {
    const rows = await select(this.db)
      .from(boardGroupGrants)
      .leftJoin(groups, eq(boardGroupGrants.group_id, groups.group_id))
      .where(eq(boardGroupGrants.board_id, boardId))
      .all();
    return rows.map((r: { board_group_grants: BoardGroupGrantRow; groups?: GroupRow | null }) =>
      this.rowToBoardGrant(r.board_group_grants, r.groups ? this.rowToGroup(r.groups) : undefined)
    );
  }

  async upsertBoardGrant(data: {
    board_id: string;
    group_id: string;
    can: BranchPermissionLevel;
    fs_access?: 'none' | 'read' | 'write' | null;
    created_by?: UserID;
  }): Promise<BoardGroupGrantWithGroup> {
    const now = new Date();
    const existing = await select(this.db)
      .from(boardGroupGrants)
      .where(
        and(
          eq(boardGroupGrants.board_id, data.board_id),
          eq(boardGroupGrants.group_id, data.group_id)
        )
      )
      .one();

    if (existing) {
      await update(this.db, boardGroupGrants)
        .set({ can: data.can, fs_access: data.fs_access ?? null, updated_at: now })
        .where(
          and(
            eq(boardGroupGrants.board_id, data.board_id),
            eq(boardGroupGrants.group_id, data.group_id)
          )
        )
        .run();
    } else {
      await insert(this.db, boardGroupGrants)
        .values({
          board_id: data.board_id as BoardID,
          group_id: data.group_id as GroupID,
          can: data.can,
          fs_access: data.fs_access ?? null,
          created_by: data.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .run();
    }

    const grants = await this.listBoardGrants(data.board_id);
    const grant = grants.find((g) => g.group_id === data.group_id);
    if (!grant) throw new RepositoryError('Failed to retrieve board group grant');
    return grant;
  }

  async removeBoardGrant(
    boardId: string,
    groupId: string
  ): Promise<BoardGroupGrantWithGroup | null> {
    const existing =
      (await this.listBoardGrants(boardId)).find((g) => g.group_id === groupId) ?? null;
    if (!existing) return null;
    await deleteFrom(this.db, boardGroupGrants)
      .where(and(eq(boardGroupGrants.board_id, boardId), eq(boardGroupGrants.group_id, groupId)))
      .run();
    return existing;
  }

  async getBoardGrantsForUser(boardId: string, userId: string): Promise<BoardGroupGrant[]> {
    const rows = await select(this.db)
      .from(boardGroupGrants)
      .innerJoin(groupMemberships, eq(boardGroupGrants.group_id, groupMemberships.group_id))
      .innerJoin(groups, eq(groupMemberships.group_id, groups.group_id))
      .where(
        and(
          eq(boardGroupGrants.board_id, boardId),
          eq(groupMemberships.user_id, userId),
          eq(groups.archived, false)
        )
      )
      .all();
    return rows.map((row: { board_group_grants: BoardGroupGrantRow }) =>
      this.rowToBoardGrant(row.board_group_grants)
    );
  }
}
