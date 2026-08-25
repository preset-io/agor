import type {
  CapabilityPolicyCapability,
  CapabilityPolicyDraft,
  CapabilityPolicyFsAccess,
  CapabilityPolicyPrincipalDescriptor,
  GroupID,
  UserID,
} from '@agor/core/types';
import {
  capabilityPolicyPrincipalKey,
  normalizeCapabilityPolicyCapabilities,
} from '@agor/core/types';
import { allCapabilitiesForKind } from './policyEditorModel';

/** Fixture-only subject model. This must not be imported by authorization code. */
export interface PrototypeAccessSubject {
  user: CapabilityPolicyPrincipalDescriptor & {
    principal: { principal_type: 'user'; user_id: UserID };
  };
  groupIds: GroupID[];
}

export interface PrototypeAccessSource {
  key: string;
  label: string;
  kind: 'owner' | 'user' | 'group' | 'others';
}

export interface PrototypeEffectiveAccess {
  capabilities: CapabilityPolicyCapability[];
  fsAccess: CapabilityPolicyFsAccess;
  sources: PrototypeAccessSource[];
  isOwner: boolean;
  usedOthers: boolean;
  deniedReason?: string;
}

const fsRank: Readonly<Record<CapabilityPolicyFsAccess, number>> = {
  none: 0,
  read: 1,
  write: 2,
};

function maxFsAccess(
  left: CapabilityPolicyFsAccess,
  right: CapabilityPolicyFsAccess
): CapabilityPolicyFsAccess {
  return fsRank[right] > fsRank[left] ? right : left;
}

function descriptorLabel(descriptor: CapabilityPolicyPrincipalDescriptor | undefined): string {
  return descriptor?.display_name ?? 'Unavailable principal';
}

/**
 * UI-only explanation helper for static fixtures. It mirrors the proposed
 * fallback/union model so designers can inspect the form, but is not an
 * authorization evaluator and must never gate product behavior.
 */
export function resolvePrototypeEffectiveAccess(options: {
  policy: CapabilityPolicyDraft;
  primaryOwnerUserId: UserID;
  subject: PrototypeAccessSubject;
  principals: CapabilityPolicyPrincipalDescriptor[];
}): PrototypeEffectiveAccess {
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
    return {
      capabilities: [...allCapabilitiesForKind(policy.policy_kind)],
      fsAccess: policy.policy_kind === 'branch_access' ? 'write' : 'none',
      sources: [{ key: `owner:${subjectId}`, label: 'Immutable primary owner', kind: 'owner' }],
      isOwner: true,
      usedOthers: false,
    };
  }

  if (policy.sharing_mode === 'private') {
    return {
      capabilities: [],
      fsAccess: 'none',
      sources: [],
      isOwner: false,
      usedOthers: false,
      deniedReason: 'This resource is private to its immutable primary owner.',
    };
  }

  const descriptorByKey = new Map(
    principals.map((principal) => [capabilityPolicyPrincipalKey(principal.principal), principal])
  );
  const groupKeys = new Set(subject.groupIds.map((groupId) => `group:${groupId}`));
  const matchingEntries = policy.entries.filter((entry) => {
    const key = capabilityPolicyPrincipalKey(entry.principal);
    const descriptor = descriptorByKey.get(key);
    if (descriptor?.status !== 'active') return false;
    if (entry.principal.principal_type === 'user') {
      return entry.principal.user_id === subjectId;
    }
    return groupKeys.has(key);
  });

  const capabilities = new Set<CapabilityPolicyCapability>();
  let fsAccess: CapabilityPolicyFsAccess = 'none';
  const sources: PrototypeAccessSource[] = [];

  for (const entry of matchingEntries) {
    for (const capability of entry.capabilities) capabilities.add(capability);
    fsAccess = maxFsAccess(fsAccess, entry.fs_access);
    const key = capabilityPolicyPrincipalKey(entry.principal);
    sources.push({
      key,
      label: descriptorLabel(descriptorByKey.get(key)),
      kind: entry.principal.principal_type,
    });
  }

  const usedOthers = matchingEntries.length === 0;
  if (usedOthers) {
    for (const capability of policy.others.capabilities) capabilities.add(capability);
    fsAccess = maxFsAccess(fsAccess, policy.others.fs_access);
    sources.push({ key: 'others', label: 'Others fallback', kind: 'others' });
  }

  return {
    capabilities: normalizeCapabilityPolicyCapabilities(policy.policy_kind, [...capabilities]),
    fsAccess,
    sources,
    isOwner: false,
    usedOthers,
  };
}
