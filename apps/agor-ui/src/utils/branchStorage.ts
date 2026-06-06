import {
  BRANCH_STORAGE_MODES,
  type BranchStorageMode,
  DEFAULT_BRANCH_STORAGE_MODE,
  type ResolvedBranchStorageConfig,
} from '@agor/core/config/browser';

export { BRANCH_STORAGE_MODES, type BranchStorageMode };
export type BranchStorageConfig = Partial<ResolvedBranchStorageConfig>;

export function isBranchStorageMode(value: unknown): value is BranchStorageMode {
  return typeof value === 'string' && (BRANCH_STORAGE_MODES as readonly string[]).includes(value);
}

export function resolveUiBranchStorageConfig(
  config?: BranchStorageConfig
): ResolvedBranchStorageConfig {
  const allowedModes = Array.isArray(config?.allowedModes)
    ? config.allowedModes.filter(isBranchStorageMode)
    : [...BRANCH_STORAGE_MODES];
  const nonEmptyAllowedModes = allowedModes.length > 0 ? allowedModes : [...BRANCH_STORAGE_MODES];
  const requestedDefault = isBranchStorageMode(config?.defaultMode)
    ? config.defaultMode
    : DEFAULT_BRANCH_STORAGE_MODE;

  return {
    defaultMode: nonEmptyAllowedModes.includes(requestedDefault)
      ? requestedDefault
      : nonEmptyAllowedModes[0],
    allowedModes: nonEmptyAllowedModes,
  };
}

export function normalizeBranchStorageMode(
  mode: unknown,
  config?: BranchStorageConfig
): BranchStorageMode {
  const resolved = resolveUiBranchStorageConfig(config);
  return isBranchStorageMode(mode) && resolved.allowedModes.includes(mode)
    ? mode
    : resolved.defaultMode;
}

export function getStorageModeLabel(mode: BranchStorageMode): string {
  return mode === 'worktree' ? 'Worktree' : 'Clone';
}
