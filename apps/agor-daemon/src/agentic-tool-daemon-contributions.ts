import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import type { AgenticToolName, Session } from '@agor/core/types';

/**
 * Result of a tool's executor-launch hook: a key used to serialize native-state
 * mutations plus a partial executor payload to merge into the spawn. Shaped from
 * OpenCode's hook — the only real implementation today.
 */
export type ExecutorLaunchContribution = ReturnType<
  typeof OPENCODE_DAEMON_CONTRIBUTION.getExecutorLaunch
>;

/**
 * Per-tool daemon-side contribution.
 *
 * Phase 2 generalizes OpenCode's previously tool-specific executor-launch hook
 * so the shape exists for every agentic tool. OpenCode keeps its real
 * implementation byte-for-byte; every other tool is an inert no-op (no
 * `getExecutorLaunch`) and therefore behaves exactly as before. A later phase
 * populates the other tools with real hooks — this phase only exposes the seam.
 */
export interface AgenticToolDaemonContribution {
  name: string;
  /**
   * Optional hook contributing native-state serialization + executor payload at
   * launch time. Absent for tools that need no special launch handling; when
   * absent, the caller spawns the executor with today's default path.
   */
  getExecutorLaunch?: (input: {
    tenantId: string;
    session: Pick<Session, 'created_by' | 'unix_username'>;
    homeDir: string;
  }) => ExecutorLaunchContribution;
}

/**
 * Registry of daemon contributions, one per agentic tool. OpenCode wires its
 * real contribution; all others are inert no-ops in this phase.
 */
export const AGENTIC_TOOL_DAEMON_CONTRIBUTIONS: Readonly<
  Record<AgenticToolName, AgenticToolDaemonContribution>
> = Object.freeze({
  'claude-code': { name: 'claude-code' },
  codex: { name: 'codex' },
  gemini: { name: 'gemini' },
  opencode: OPENCODE_DAEMON_CONTRIBUTION,
  copilot: { name: 'copilot' },
  cursor: { name: 'cursor' },
});

/**
 * Resolve the daemon contribution for a tool. Accepts the persisted tool name
 * (which may be a legacy identifier no longer in the registry) and returns
 * `undefined` for anything unmapped, so callers fall through to the default
 * launch path.
 */
export function getAgenticToolDaemonContribution(
  tool: string
): AgenticToolDaemonContribution | undefined {
  return (AGENTIC_TOOL_DAEMON_CONTRIBUTIONS as Record<string, AgenticToolDaemonContribution>)[tool];
}
