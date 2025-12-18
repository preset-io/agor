// src/types/ide.ts

/**
 * VS Code integration modes
 *
 * - remote-ssh: Use Remote - SSH via vscode://vscode-remote/ssh-remote+
 * - local: Use vscode://file to open a local path directly
 */
export type VSCodeOpenMode = 'remote-ssh' | 'local';

/**
 * Result returned by /worktrees/:id/vscode endpoint
 */
export interface VSCodeOpenResult {
  /** Whether IDE integration is enabled */
  enabled: boolean;

  /** Mode that will be used to open VS Code */
  mode?: VSCodeOpenMode;

  /** vscode:// URI to open */
  uri?: string;

  /** Optional user-facing reason when `enabled` is false or URI is unavailable */
  reason?: string;

  /** Remote SSH target label (helpful for tooltips) */
  targetLabel?: string;

  /** Suggested SSH command for reference */
  sshCommand?: string;
}

/**
 * Result returned by /worktrees-open-codeserver endpoint
 */
export interface CodeServerOpenResult {
  enabled: boolean;
  url?: string;
  reason?: string;
}
