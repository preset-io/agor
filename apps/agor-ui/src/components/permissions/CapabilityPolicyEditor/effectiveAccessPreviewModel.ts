import type {
  CapabilityPolicyCapability,
  CapabilityPolicyDraft,
  CapabilityPolicyFsAccess,
  CapabilityPolicyPrincipalDescriptor,
  GroupID,
  UserID,
} from '@agor/core/types';
import { capabilityPolicyPrincipalKey, resolveCapabilityPolicyAccess } from '@agor/core/types';

/** Hydrated subject used by the read-only, on-demand access explanation. */
export interface EffectiveAccessSubject {
  user: CapabilityPolicyPrincipalDescriptor & {
    principal: { principal_type: 'user'; user_id: UserID };
  };
  groupIds: GroupID[];
}

export interface EffectiveAccessPreviewSource {
  key: string;
  label: string;
  kind: 'owner' | 'user' | 'group' | 'others';
}

export interface EffectiveAccessPreviewResult {
  capabilities: CapabilityPolicyCapability[];
  fsAccess: CapabilityPolicyFsAccess;
  sources: EffectiveAccessPreviewSource[];
  isOwner: boolean;
  usedOthers: boolean;
  deniedReason?: string;
}

function descriptorLabel(descriptor: CapabilityPolicyPrincipalDescriptor | undefined): string {
  return descriptor?.display_name ?? 'Unavailable principal';
}

/**
 * UI-only explanation helper. Capability resolution delegates to the shared
 * canonical evaluator; this layer only hydrates human-readable source labels.
 * It must never gate product behavior.
 */
export function resolveEffectiveAccessPreview(options: {
  policy: CapabilityPolicyDraft;
  primaryOwnerUserId: UserID;
  subject: EffectiveAccessSubject;
  principals: CapabilityPolicyPrincipalDescriptor[];
}): EffectiveAccessPreviewResult {
  const { policy, primaryOwnerUserId, subject, principals } = options;
  const subjectId = subject.user.principal.user_id;

  if (subject.user.status !== 'active') {
    return {
      capabilities: [],
      fsAccess: 'none',
      sources: [],
      isOwner: subjectId === primaryOwnerUserId,
      usedOthers: false,
      deniedReason:
        subject.user.status === 'inactive'
          ? 'Inactive people do not receive effective access.'
          : 'Deleted principals do not receive effective access.',
    };
  }

  if (subjectId === primaryOwnerUserId) {
    const access = resolveCapabilityPolicyAccess({
      policy,
      primary_owner_user_id: primaryOwnerUserId,
      user_id: subjectId,
      user_status: subject.user.status,
      active_group_ids: subject.groupIds,
    });
    return {
      capabilities: access.capabilities,
      fsAccess: access.fs_access,
      sources: [{ key: `owner:${subjectId}`, label: 'Primary owner', kind: 'owner' }],
      isOwner: true,
      usedOthers: false,
    };
  }

  const descriptorByKey = new Map(
    principals.map((principal) => [capabilityPolicyPrincipalKey(principal.principal), principal])
  );
  const activePolicy: CapabilityPolicyDraft = {
    ...policy,
    entries: policy.entries.filter(
      (entry) =>
        descriptorByKey.get(capabilityPolicyPrincipalKey(entry.principal))?.status === 'active'
    ),
  };
  const access = resolveCapabilityPolicyAccess({
    policy: activePolicy,
    primary_owner_user_id: primaryOwnerUserId,
    user_id: subjectId,
    user_status: subject.user.status,
    active_group_ids: subject.groupIds,
  });

  if (activePolicy.sharing_mode === 'private') {
    return {
      capabilities: [],
      fsAccess: 'none',
      sources: [],
      isOwner: false,
      usedOthers: false,
      deniedReason: 'This resource is private.',
    };
  }

  const sources: EffectiveAccessPreviewSource[] =
    access.source === 'direct_user'
      ? [
          {
            key: `user:${subjectId}`,
            label: descriptorLabel(descriptorByKey.get(`user:${subjectId}`)),
            kind: 'user',
          },
        ]
      : access.source === 'group'
        ? access.group_ids.map((groupId) => ({
            key: `group:${groupId}`,
            label: descriptorLabel(descriptorByKey.get(`group:${groupId}`)),
            kind: 'group' as const,
          }))
        : [{ key: 'others', label: 'Others fallback', kind: 'others' as const }];
  const usedOthers = access.source === 'others';

  return {
    capabilities: access.capabilities,
    fsAccess: access.fs_access,
    sources,
    isOwner: false,
    usedOthers,
  };
}
