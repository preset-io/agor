import type { MCPServer } from '@agor-live/client';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';

export interface SessionMcpSummary {
  attachedCount: number;
  missingCount: number;
  needsAuthCount: number;
  healthyCount: number;
  tone: 'default' | 'warning' | 'error';
  label: string;
  tooltip: string;
}

export function summarizeSessionMcpServers(
  serverIds: string[],
  mcpServerById: Map<string, MCPServer>,
  userAuthenticatedMcpServerIds: Set<string>
): SessionMcpSummary {
  let missingCount = 0;
  let needsAuthCount = 0;

  for (const serverId of serverIds) {
    const server = mcpServerById.get(serverId);
    if (!server) {
      missingCount += 1;
      continue;
    }
    if (mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)) {
      needsAuthCount += 1;
    }
  }

  const attachedCount = serverIds.length;
  const healthyCount = Math.max(0, attachedCount - missingCount - needsAuthCount);
  const problemCount = missingCount + needsAuthCount;
  const tone: SessionMcpSummary['tone'] =
    missingCount > 0 ? 'error' : needsAuthCount > 0 ? 'warning' : 'default';

  return {
    attachedCount,
    missingCount,
    needsAuthCount,
    healthyCount,
    tone,
    label: `MCP (${attachedCount})`,
    tooltip:
      problemCount > 0
        ? `${problemCount} MCP server${problemCount === 1 ? '' : 's'} need attention`
        : attachedCount > 0
          ? `${attachedCount} MCP server${attachedCount === 1 ? '' : 's'} attached`
          : 'No MCP servers attached',
  };
}
