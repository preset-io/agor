import type { BranchPermissionLevel } from './branch';
import type { BranchID, GroupID, UserID } from './id';

export interface Group {
  group_id: GroupID;
  name: string;
  slug: string;
  description?: string;
  archived: boolean;
  created_by?: UserID;
  created_at: string;
  updated_at: string;
}

export interface GroupMembership {
  group_id: GroupID;
  user_id: UserID;
  added_by?: UserID;
  created_at: string;
}

export type BranchFsAccessLevel = 'none' | 'read' | 'write';

export interface BranchGroupGrant {
  branch_id: BranchID;
  group_id: GroupID;
  can: BranchPermissionLevel;
  fs_access?: BranchFsAccessLevel;
  created_by?: UserID;
  created_at: string;
  updated_at: string;
}

export interface BranchGroupGrantWithGroup extends BranchGroupGrant {
  group?: Group;
}

export interface EffectiveBranchAccess {
  can: BranchPermissionLevel;
  fs_access?: BranchFsAccessLevel;
  is_owner: boolean;
  source: 'owner' | 'group' | 'others' | 'superadmin';
  group_ids?: GroupID[];
}
