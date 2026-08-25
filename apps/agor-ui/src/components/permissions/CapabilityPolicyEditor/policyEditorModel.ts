import type {
  CapabilityPolicyCapability,
  CapabilityPolicyDraft,
  CapabilityPolicyEntryDraft,
  CapabilityPolicyFsAccess,
  CapabilityPolicyKind,
  CapabilityPolicyOthersDraft,
  CapabilityPolicyPresetId,
} from '@agor/core/types';
import {
  BOARD_POLICY_CAPABILITIES,
  BRANCH_POLICY_CAPABILITIES,
  normalizeCapabilityPolicyCapabilities,
  removeCapabilityPolicyCapability,
} from '@agor/core/types';

export interface CapabilityOption {
  value: CapabilityPolicyCapability;
  label: string;
  summary: string;
  family: 'View' | 'Prompt / execute' | 'Manage';
}

export interface CapabilityPresetDefinition {
  id: Exclude<CapabilityPolicyPresetId, 'custom'>;
  label: string;
  summary: string;
  capabilities: readonly CapabilityPolicyCapability[];
  fsAccess: CapabilityPolicyFsAccess;
}

export interface CapabilityPolicyEditorContext {
  kind: CapabilityPolicyKind;
  resourceLabel: string;
  sharedDescription: string;
  privateDescription: string;
  supportsFilesystem: boolean;
  capabilities: readonly CapabilityOption[];
  presets: readonly CapabilityPresetDefinition[];
}

const BOARD_CAPABILITY_OPTIONS: readonly CapabilityOption[] = [
  {
    value: 'board.view',
    label: 'View board',
    summary: 'See board details, the canvas, and only the branch cards they may access.',
    family: 'View',
  },
  {
    value: 'board.edit',
    label: 'Edit board',
    summary: 'Change board details, layout, zones, and other collaborative canvas content.',
    family: 'Manage',
  },
  {
    value: 'board.attach_branch',
    label: 'Attach branches',
    summary: 'Add or move branch references; branch access is still checked separately.',
    family: 'Manage',
  },
  {
    value: 'board.policy.manage',
    label: 'Manage board access',
    summary: 'Edit shared access entries. The immutable primary owner cannot be changed.',
    family: 'Manage',
  },
];

const BRANCH_CAPABILITY_OPTIONS: readonly CapabilityOption[] = [
  {
    value: 'branch.view',
    label: 'View branch',
    summary: 'See branch details plus its sessions, tasks, messages, and reports.',
    family: 'View',
  },
  {
    value: 'sessions.create',
    label: 'Create own sessions',
    summary: 'Start sessions owned by the signed-in person and using only their own home.',
    family: 'Prompt / execute',
  },
  {
    value: 'sessions.prompt_own',
    label: 'Prompt / execute own sessions',
    summary: 'Continue only sessions owned by the signed-in person. Never another user’s home.',
    family: 'Prompt / execute',
  },
  {
    value: 'terminal.open',
    label: 'Open own terminal',
    summary: 'Open a terminal as the signed-in person, subject to execution-mode safeguards.',
    family: 'Prompt / execute',
  },
  {
    value: 'sessions.manage_others',
    label: 'Manage others’ sessions',
    summary: 'Stop, archive, or delete for containment. Does not allow prompting or execution.',
    family: 'Manage',
  },
  {
    value: 'branch.manage',
    label: 'Manage branch',
    summary: 'Edit branch metadata and lifecycle without borrowing another user’s identity.',
    family: 'Manage',
  },
  {
    value: 'environment.control',
    label: 'Control environment',
    summary: 'Start, stop, inspect, or reset the branch environment.',
    family: 'Manage',
  },
  {
    value: 'branch.policy.manage',
    label: 'Manage branch access',
    summary: 'Edit shared entries. The immutable primary owner cannot be changed.',
    family: 'Manage',
  },
];

const BOARD_PRESETS: readonly CapabilityPresetDefinition[] = [
  {
    id: 'none',
    label: 'No access',
    summary: 'No board access.',
    capabilities: [],
    fsAccess: 'none',
  },
  {
    id: 'viewer',
    label: 'Viewer',
    summary: 'Can see the board and authorized branch cards.',
    capabilities: ['board.view'],
    fsAccess: 'none',
  },
  {
    id: 'editor',
    label: 'Editor',
    summary: 'Can edit the board and attach branches.',
    capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
    fsAccess: 'none',
  },
  {
    id: 'manager',
    label: 'Manager',
    summary: 'Can manage board access. Never becomes an owner.',
    capabilities: BOARD_POLICY_CAPABILITIES,
    fsAccess: 'none',
  },
];

const BRANCH_PRESETS: readonly CapabilityPresetDefinition[] = [
  {
    id: 'none',
    label: 'No access',
    summary: 'No branch access.',
    capabilities: [],
    fsAccess: 'none',
  },
  {
    id: 'discover',
    label: 'Discover',
    summary: 'Can see branch and conversation metadata, but not files.',
    capabilities: ['branch.view'],
    fsAccess: 'none',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    summary: 'Can read the branch, conversations, and files.',
    capabilities: ['branch.view'],
    fsAccess: 'read',
  },
  {
    id: 'collaborator',
    label: 'Collaborator',
    summary: 'Can create and prompt only their own sessions and terminal.',
    capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own', 'terminal.open'],
    fsAccess: 'read',
  },
  {
    id: 'manager',
    label: 'Manager',
    summary: 'Can manage branch, access, environment, and others’ lifecycle — not execute.',
    capabilities: [
      'branch.view',
      'sessions.manage_others',
      'branch.manage',
      'environment.control',
      'branch.policy.manage',
    ],
    fsAccess: 'write',
  },
];

export const BOARD_ACCESS_EDITOR_CONTEXT: CapabilityPolicyEditorContext = {
  kind: 'board_access',
  resourceLabel: 'board',
  sharedDescription: 'Named people, groups, and an explicit fallback can access this board.',
  privateDescription: 'Only the immutable primary owner can access this board.',
  supportsFilesystem: false,
  capabilities: BOARD_CAPABILITY_OPTIONS,
  presets: BOARD_PRESETS,
};

export const BRANCH_ACCESS_EDITOR_CONTEXT: CapabilityPolicyEditorContext = {
  kind: 'branch_access',
  resourceLabel: 'branch',
  sharedDescription: 'Named people, groups, and an explicit fallback can access this branch.',
  privateDescription: 'Only the immutable primary owner can access this branch.',
  supportsFilesystem: true,
  capabilities: BRANCH_CAPABILITY_OPTIONS,
  presets: BRANCH_PRESETS,
};

export function getPolicyEditorContext(kind: CapabilityPolicyKind): CapabilityPolicyEditorContext {
  return kind === 'board_access' ? BOARD_ACCESS_EDITOR_CONTEXT : BRANCH_ACCESS_EDITOR_CONTEXT;
}

export function getCapabilityPreset(
  context: CapabilityPolicyEditorContext,
  presetId: CapabilityPolicyPresetId
): CapabilityPresetDefinition | undefined {
  return context.presets.find((preset) => preset.id === presetId);
}

export function matchingCapabilityPreset(
  context: CapabilityPolicyEditorContext,
  capabilities: readonly CapabilityPolicyCapability[],
  fsAccess: CapabilityPolicyFsAccess
): CapabilityPolicyPresetId {
  const normalized = normalizeCapabilityPolicyCapabilities(context.kind, capabilities);
  const preset = context.presets.find(
    (candidate) =>
      candidate.fsAccess === (context.supportsFilesystem ? fsAccess : 'none') &&
      candidate.capabilities.length === normalized.length &&
      candidate.capabilities.every((capability) => normalized.includes(capability))
  );
  return preset?.id ?? 'custom';
}

export function applyCapabilityPreset<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>(value: T, context: CapabilityPolicyEditorContext, presetId: CapabilityPolicyPresetId): T {
  const preset = getCapabilityPreset(context, presetId);
  if (!preset) return { ...value, preset: 'custom' };
  return {
    ...value,
    preset: preset.id,
    capabilities: [...preset.capabilities],
    fs_access: context.supportsFilesystem ? preset.fsAccess : 'none',
  };
}

export function toggleCapability<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>(
  value: T,
  context: CapabilityPolicyEditorContext,
  capability: CapabilityPolicyCapability,
  checked: boolean
): T {
  const capabilities = checked
    ? normalizeCapabilityPolicyCapabilities(context.kind, [...value.capabilities, capability])
    : removeCapabilityPolicyCapability(context.kind, value.capabilities, capability);
  return {
    ...value,
    capabilities,
    preset: matchingCapabilityPreset(context, capabilities, value.fs_access),
  };
}

export function updateFilesystemAccess<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>(value: T, context: CapabilityPolicyEditorContext, fsAccess: CapabilityPolicyFsAccess): T {
  const normalizedFs = context.supportsFilesystem ? fsAccess : 'none';
  return {
    ...value,
    fs_access: normalizedFs,
    preset: matchingCapabilityPreset(context, value.capabilities, normalizedFs),
  };
}

export function makePrivatePolicy(policy: CapabilityPolicyDraft): CapabilityPolicyDraft {
  return {
    ...policy,
    sharing_mode: 'private',
    entries: [],
    others: { preset: 'none', capabilities: [], fs_access: 'none' },
  };
}

export function makeSharedClosedPolicy(policy: CapabilityPolicyDraft): CapabilityPolicyDraft {
  return {
    ...policy,
    sharing_mode: 'shared',
    entries: [],
    others: { preset: 'none', capabilities: [], fs_access: 'none' },
  };
}

export const fsAccessLabel: Readonly<Record<CapabilityPolicyFsAccess, string>> = {
  none: 'No files',
  read: 'Read files',
  write: 'Read & write files',
};

export const fsAccessDescription: Readonly<Record<CapabilityPolicyFsAccess, string>> = {
  none: 'No filesystem projection.',
  read: 'Read-only filesystem projection.',
  write: 'Read and write filesystem projection.',
};

export const allCapabilitiesForKind = (
  kind: CapabilityPolicyKind
): readonly CapabilityPolicyCapability[] =>
  kind === 'board_access' ? BOARD_POLICY_CAPABILITIES : BRANCH_POLICY_CAPABILITIES;
