import { BadRequest } from '@agor/core/feathers';
import {
  type AgenticToolName,
  isAgenticToolName,
  type PersistedAgenticToolName,
} from '@agor/core/types';

export const REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE =
  'This session uses the removed experimental Claude Code CLI integration. Its history remains readable, but it cannot be prompted, resumed, forked, spawned from, or restarted. Create a new session with a supported agentic tool.';

/**
 * Narrow a persisted session tool to one that may be used for new work.
 *
 * The persisted type deliberately includes removed identifiers so historical
 * rows can be read without rewriting their attribution. Runtime entry points
 * must call this guard rather than interpreting a removed tool as another
 * adapter.
 */
export function requireActiveAgenticTool(tool: PersistedAgenticToolName): AgenticToolName {
  if (!isAgenticToolName(tool)) {
    throw new BadRequest(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
  }
  return tool;
}
