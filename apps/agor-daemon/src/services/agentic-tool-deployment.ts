import type { AgenticToolName } from '@agor/core/types';

export function deploymentAgenticToolUnavailableMessage(tool: AgenticToolName): string {
  return `${tool} is unavailable under this deployment's agentic-tool policy. A deployment operator must add it to agentic_tools.installed in config.yaml, run agor install --sync, and restart the daemon.`;
}
