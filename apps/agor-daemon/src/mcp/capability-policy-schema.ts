import { BOARD_POLICY_CAPABILITIES, BRANCH_POLICY_CAPABILITIES } from '@agor/core/types';
import { z } from 'zod';

const id = z.string().min(1);
const principal = z.discriminatedUnion('principal_type', [
  z.object({ principal_type: z.literal('user'), user_id: id }),
  z.object({ principal_type: z.literal('group'), group_id: id }),
]);
const fsAccess = z.enum(['none', 'read', 'write']);

function policy(kind: 'board_access' | 'branch_access') {
  const preset =
    kind === 'board_access'
      ? z.enum(['none', 'viewer', 'editor', 'manager'])
      : z.enum(['none', 'viewer', 'collaborator', 'manager']);
  const capability = z.enum(
    kind === 'board_access' ? BOARD_POLICY_CAPABILITIES : BRANCH_POLICY_CAPABILITIES
  );
  const value = z.object({ preset, capabilities: z.array(capability), fs_access: fsAccess });
  return z.object({
    schema_version: z.literal(1),
    policy_kind: z.literal(kind),
    sharing_mode: z.enum(['private', 'shared']),
    entries: z.array(value.extend({ entry_id: id, principal })),
    others: value,
  });
}

export const branchPermissionConfigSchema = z.object({
  access: policy('branch_access'),
  allow_shared_session_prompts: z.boolean(),
});

export const boardCapabilityPoliciesSchema = z.object({
  primary_owner_user_id: id,
  board_access_revision: z.number().int().nonnegative().optional(),
  branch_template_revision: z.number().int().nonnegative().optional(),
  board_access: policy('board_access'),
  branch_template: branchPermissionConfigSchema,
});

export const branchCapabilityPolicySchema = z.object({
  primary_owner_user_id: id,
  revision: z.number().int().nonnegative().optional(),
  binding_mode: z.enum(['inherit', 'override']),
  inherited_from_board_id: id.optional(),
  inherited_config: branchPermissionConfigSchema.optional(),
  override_config: branchPermissionConfigSchema.optional(),
});
