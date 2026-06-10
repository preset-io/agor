import type { BranchPermissionLevel } from './branch';
import type { BoardID, BranchID, GroupID, UserID } from './id';

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

export interface BoardGroupGrant {
  board_id: BoardID;
  group_id: GroupID;
  can: BranchPermissionLevel;
  fs_access?: BranchFsAccessLevel;
  created_by?: UserID;
  created_at: string;
  updated_at: string;
}

export interface BoardGroupGrantWithGroup extends BoardGroupGrant {
  group?: Group;
}

export interface EffectiveBranchAccess {
  can: BranchPermissionLevel;
  fs_access?: BranchFsAccessLevel;
  dangerously_allow_session_sharing?: boolean;
  is_owner: boolean;
  source: 'owner' | 'group' | 'board_group' | 'others' | 'board' | 'superadmin';
  group_ids?: GroupID[];
}
