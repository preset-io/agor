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

/**
 * Product-facing role implication. The proposed authorization contract stays
 * granular, but the form exposes only named roles rather than independent
 * capability switches.
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
}

export interface CapabilityPolicyEditorContext {
  kind: CapabilityPolicyKind;
  resourceLabel: string;
  sharedDescription: string;
  privateDescription: string;
  supportsFilesystem: boolean;
  controlGroups: readonly CapabilityControlGroup[];
  presets: readonly CapabilityPresetDefinition[];
}

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
    summary: 'Manage settings, access, environment, and session lifecycle.',
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
  },
  {
    id: 'viewer',
    label: 'Viewer',
    summary: 'Can view the board.',
    capabilities: ['board.view'],
  },
  {
    id: 'editor',
    label: 'Editor',
    summary: 'Can edit the board, but not its permissions.',
    capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
  },
  {
    id: 'manager',
    label: 'Manager',
    summary: 'Can edit the board and manage its permissions.',
    capabilities: BOARD_POLICY_CAPABILITIES,
  },
];

const BRANCH_PRESETS: readonly CapabilityPresetDefinition[] = [
  {
    id: 'none',
    label: 'No access',
    summary: 'No branch access.',
    capabilities: [],
  },
  {
    id: 'viewer',
    label: 'Viewer',
    summary: 'Can view the branch and its sessions.',
    capabilities: ['branch.view'],
  },
  {
    id: 'collaborator',
    label: 'Collaborator',
    summary: 'Can create and prompt their own sessions. Allows terminal access with file access.',
    capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own'],
  },
  {
    id: 'manager',
    label: 'Manager',
    summary:
      'Can work in their own sessions and manage the branch, environment, and access. Allows terminal access with file access.',
    capabilities: [
      'branch.view',
      'sessions.create',
      'sessions.prompt_own',
      'sessions.manage_others',
      'branch.manage',
      'environment.control',
      'branch.policy.manage',
    ],
  },
];

export const BOARD_ACCESS_EDITOR_CONTEXT: CapabilityPolicyEditorContext = {
  kind: 'board_access',
  resourceLabel: 'board',
  sharedDescription: 'Grant access to people, groups, or Others.',
  privateDescription: 'Only the primary owner can access this board.',
  supportsFilesystem: false,
  controlGroups: BOARD_CONTROL_GROUPS,
  presets: BOARD_PRESETS,
};

export const BRANCH_ACCESS_EDITOR_CONTEXT: CapabilityPolicyEditorContext = {
  kind: 'branch_access',
  resourceLabel: 'branch',
  sharedDescription: 'Grant access to people, groups, or Others.',
  privateDescription: 'Only the primary owner can access this branch.',
  supportsFilesystem: true,
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
  const preset = context.presets.find((candidate) => {
    const roleCapabilities = synchronizeProductCapabilities(
      context,
      candidate.capabilities,
      candidate.id === 'none' ? 'none' : fsAccess
    );
    return (
      roleCapabilities.length === normalized.length &&
      roleCapabilities.every((capability) => normalized.includes(capability))
    );
  });
  return preset?.id ?? 'custom';
}

export function applyCapabilityPreset<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>(value: T, context: CapabilityPolicyEditorContext, presetId: CapabilityPolicyPresetId): T {
  const preset = getCapabilityPreset(context, presetId);
  if (!preset) return { ...value, preset: 'custom' };
  const fsAccess = context.supportsFilesystem && preset.id !== 'none' ? value.fs_access : 'none';
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
 * projection. Filesystem access alone (for example a Viewer with read access)
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

export function updateFilesystemAccess<
  T extends CapabilityPolicyEntryDraft | CapabilityPolicyOthersDraft,
>(value: T, context: CapabilityPolicyEditorContext, fsAccess: CapabilityPolicyFsAccess): T {
  const normalizedFs = context.supportsFilesystem && value.preset !== 'none' ? fsAccess : 'none';
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
  none: 'None',
  read: 'Read',
  write: 'Read/write',
};

export const allCapabilitiesForKind = (
  kind: CapabilityPolicyKind
): readonly CapabilityPolicyCapability[] =>
  kind === 'board_access' ? BOARD_POLICY_CAPABILITIES : BRANCH_POLICY_CAPABILITIES;
