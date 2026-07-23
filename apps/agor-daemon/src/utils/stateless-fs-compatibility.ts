import { AGENTIC_TOOL_CAPABILITIES, type AgenticToolName } from '@agor/core/types';

export function assertStatelessFsModeCompatible(
  tool: AgenticToolName,
  statelessFsMode: boolean | undefined
): void {
  if (!statelessFsMode || AGENTIC_TOOL_CAPABILITIES[tool].supportsStatelessFsMode) return;
  const supported = Object.entries(AGENTIC_TOOL_CAPABILITIES)
    .filter(([, capabilities]) => capabilities.supportsStatelessFsMode)
    .map(([name]) => name)
    .join(', ');
  throw new Error(
    `stateless_fs_mode is enabled but tool '${tool}' does not support it. Supported tools: ${supported}`
  );
}
