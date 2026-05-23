/**
 * Storage-mode form helpers.
 *
 * The "Storage" dropdown encodes both the storage_mode and (for shallow
 * clones) the clone_depth into a single composite string value, so the
 * antd Select can stay a single control. Submit handlers call
 * `parseStorageFormValue` to split it back into the
 * `{ storage_mode, clone_depth }` pair the daemon expects.
 *
 * Lives here (alongside WorktreeFormFields, the only consumer surface)
 * rather than under a tab module so the modal / table / tab forms can
 * import it without depending on each other's UI shells.
 */

export type StorageModeFormValue = 'worktree' | 'clone' | `clone:${number}`;

export interface StorageModeSelection {
  storage_mode: 'worktree' | 'clone';
  /** Only set when the user picked a shallow-clone preset. */
  clone_depth?: number;
}

/**
 * Translate the composite "Storage" form value (one of 'worktree', 'clone',
 * 'clone:100', …) into the `{storage_mode, clone_depth}` pair the daemon
 * expects. Unknown / non-string inputs fall back to the safe default.
 */
export function parseStorageFormValue(value: unknown): StorageModeSelection {
  if (typeof value !== 'string') return { storage_mode: 'worktree' };
  if (value === 'worktree') return { storage_mode: 'worktree' };
  if (value === 'clone') return { storage_mode: 'clone' };
  const m = value.match(/^clone:(\d+)$/);
  if (m) return { storage_mode: 'clone', clone_depth: Number(m[1]) };
  return { storage_mode: 'worktree' };
}
