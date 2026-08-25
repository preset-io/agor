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

/**
 * Product-facing capability bundle. The proposed authorization contract stays
 * granular, but the form should not make people reason about every low-level
 * check independently.
 */
export interface CapabilityControlGroup {
  id: 'view' | 'work' | 'edit' | 'manage';
  label: string;
  summary: string;
  capabilities: readonly CapabilityPolicyCapability[];
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
  controlGroups: readonly CapabilityControlGroup[];
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

const BOARD_CONTROL_GROUPS: readonly CapabilityControlGroup[] = [
  {
    id: 'view',
    label: 'View board',
    summary: 'See the canvas and only branch cards they may access.',
    capabilities: ['board.view'],
  },
  {
    id: 'edit',
    label: 'Edit board',
    summary: 'Change the canvas, zones, and attached branch references.',
    capabilities: ['board.edit', 'board.attach_branch'],
  },
  {
    id: 'manage',
    label: 'Manage board',
    summary: 'Edit board settings and shared access. Never becomes an owner.',
    capabilities: ['board.edit', 'board.attach_branch', 'board.policy.manage'],
  },
];

const BRANCH_CONTROL_GROUPS: readonly CapabilityControlGroup[] = [
  {
    id: 'view',
    label: 'View branch',
    summary: 'See branch details, conversations, tasks, messages, and reports.',
    capabilities: ['branch.view'],
  },
  {
    id: 'work',
    label: 'Work in own sessions',
    summary: 'Create and prompt sessions that run only as this person.',
    capabilities: ['sessions.create', 'sessions.prompt_own'],
  },
  {
    id: 'manage',
    label: 'Manage branch',
    summary: 'Manage settings, access, environment, and session lifecycle without executing.',
    capabilities: [
      'sessions.manage_others',
      'branch.manage',
      'environment.control',
      'branch.policy.manage',
    ],
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
    id: 'viewer',
    label: 'Viewer',
    summary: 'Can view the branch, conversations, and files.',
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
  controlGroups: BOARD_CONTROL_GROUPS,
  presets: BOARD_PRESETS,
};

export const BRANCH_ACCESS_EDITOR_CONTEXT: CapabilityPolicyEditorContext = {
  kind: 'branch_access',
  resourceLabel: 'branch',
  sharedDescription: 'Named people, groups, and an explicit fallback can access this branch.',
  privateDescription: 'Only the immutable primary owner can access this branch.',
  supportsFilesystem: true,
  capabilities: BRANCH_CAPABILITY_OPTIONS,
  controlGroups: BRANCH_CONTROL_GROUPS,
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
  const fsAccess = context.supportsFilesystem ? preset.fsAccess : 'none';
  const capabilities = synchronizeProductCapabilities(context, preset.capabilities, fsAccess);
  return {
    ...value,
    preset: preset.id,
    capabilities,
    fs_access: fsAccess,
  };
}

/**
 * Apply the prototype's product-level implications to the low-level contract.
 *
 * Terminal is intentionally not its own form switch. It is available only
 * when a person may work in their own sessions *and* has a filesystem
 * projection. Filesystem access alone (for example a non-executing Manager)
 * never grants a shell.
 */
export function synchronizeProductCapabilities(
  context: CapabilityPolicyEditorContext,
  capabilities: readonly CapabilityPolicyCapability[],
  fsAccess: CapabilityPolicyFsAccess
): CapabilityPolicyCapability[] {
  let normalized = normalizeCapabilityPolicyCapabilities(context.kind, capabilities);

  if (context.kind === 'board_access') {
    // The UI presents board editing as one product capability even though the
    // future evaluator may check edit and attach independently.
    if (normalized.includes('board.edit') || normalized.includes('board.attach_branch')) {
      normalized = normalizeCapabilityPolicyCapabilities(context.kind, [
        ...normalized,
        'board.edit',
        'board.attach_branch',
      ]);
    }
    return normalized;
  }

  if (fsAccess !== 'none' && !normalized.includes('branch.view')) {
    normalized = normalizeCapabilityPolicyCapabilities(context.kind, [
      ...normalized,
      'branch.view',
    ]);
  }

  const canWorkInOwnSessions =
    normalized.includes('sessions.create') && normalized.includes('sessions.prompt_own');
  const shouldOpenTerminal = canWorkInOwnSessions && fsAccess !== 'none';
  if (shouldOpenTerminal && !normalized.includes('terminal.open')) {
    normalized = normalizeCapabilityPolicyCapabilities(context.kind, [
      ...normalized,
      'terminal.open',
    ]);
  } else if (!shouldOpenTerminal && normalized.includes('terminal.open')) {
    normalized = removeCapabilityPolicyCapability(context.kind, normalized, 'terminal.open');
  }

  return normalized;
}

export function toggleCapability<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>(
  value: T,
  context: CapabilityPolicyEditorContext,
  capability: CapabilityPolicyCapability,
  checked: boolean
): T {
  const nextCapabilities = checked
    ? normalizeCapabilityPolicyCapabilities(context.kind, [...value.capabilities, capability])
    : removeCapabilityPolicyCapability(context.kind, value.capabilities, capability);
  const capabilities = synchronizeProductCapabilities(context, nextCapabilities, value.fs_access);
  return {
    ...value,
    capabilities,
    preset: matchingCapabilityPreset(context, capabilities, value.fs_access),
  };
}

export function isCapabilityControlGroupSelected(
  value: CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
  group: CapabilityControlGroup
): boolean {
  return group.capabilities.every((capability) => value.capabilities.includes(capability));
}

export function toggleCapabilityControlGroup<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>(
  value: T,
  context: CapabilityPolicyEditorContext,
  group: CapabilityControlGroup,
  checked: boolean
): T {
  let capabilities = [...value.capabilities];
  if (checked) {
    capabilities = normalizeCapabilityPolicyCapabilities(context.kind, [
      ...capabilities,
      ...group.capabilities,
    ]);
  } else {
    for (const capability of group.capabilities) {
      capabilities = removeCapabilityPolicyCapability(context.kind, capabilities, capability);
    }
  }

  const fsAccess = group.id === 'view' && !checked ? 'none' : value.fs_access;
  capabilities = synchronizeProductCapabilities(context, capabilities, fsAccess);
  return {
    ...value,
    capabilities,
    fs_access: fsAccess,
    preset: matchingCapabilityPreset(context, capabilities, fsAccess),
  };
}

export function updateFilesystemAccess<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>(value: T, context: CapabilityPolicyEditorContext, fsAccess: CapabilityPolicyFsAccess): T {
  const normalizedFs = context.supportsFilesystem ? fsAccess : 'none';
  const capabilities = synchronizeProductCapabilities(context, value.capabilities, normalizedFs);
  return {
    ...value,
    fs_access: normalizedFs,
    capabilities,
    preset: matchingCapabilityPreset(context, capabilities, normalizedFs),
  };
}

export function selectedCapabilityControlGroupLabels(
  context: CapabilityPolicyEditorContext,
  capabilities: readonly CapabilityPolicyCapability[]
): string[] {
  return context.controlGroups
    .filter((group) => group.capabilities.every((capability) => capabilities.includes(capability)))
    .map((group) => group.label);
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
  none: 'Cannot access branch files.',
  read: 'Can read branch files.',
  write: 'Can read and change branch files.',
};

export const allCapabilitiesForKind = (
  kind: CapabilityPolicyKind
): readonly CapabilityPolicyCapability[] =>
  kind === 'board_access' ? BOARD_POLICY_CAPABILITIES : BRANCH_POLICY_CAPABILITIES;
