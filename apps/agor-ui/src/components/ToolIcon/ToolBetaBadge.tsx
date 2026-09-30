import { getAgenticToolIntegration } from '@agor/agentic-tools';
import type { AgenticToolName } from '@agor-live/client';
import { Tag } from '../Tag';

export function ToolBetaBadge({ tool }: { tool: AgenticToolName }) {
  return getAgenticToolIntegration(tool).beta ? <Tag color="warning">BETA</Tag> : null;
}
