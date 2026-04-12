/**
 * ToolExecutingIndicator Component
 *
 * Shows real-time indicators when tools are being executed by the agent.
 * Displays a list of currently executing tools with visual feedback.
 */

import { LoadingOutlined } from '@ant-design/icons';
import { Space, Typography } from 'antd';
import type { ToolExecution } from '../../hooks/useTaskEvents';
import { getToolDisplayName } from '../../utils/toolDisplayName';
import { Tag } from '../Tag';

interface ToolExecutingIndicatorProps {
  toolsExecuting: ToolExecution[];
}

/**
 * Component to display real-time tool execution status
 *
 * Shows a list of tools that are currently executing or recently completed.
 * Each tool is displayed with:
 * - Tool name
 * - Execution status (spinner while running)
 */
const ToolExecutingIndicator = ({ toolsExecuting }: ToolExecutingIndicatorProps) => {
  if (toolsExecuting.length === 0) {
    return null;
  }

  return (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      {toolsExecuting.map((tool) => (
        <Tag
          key={tool.toolUseId}
          icon={<LoadingOutlined spin />}
          color="processing"
          style={{ margin: 0 }}
        >
          <Typography.Text style={{ fontSize: 12 }}>
            {getToolDisplayName(tool.toolName)}
            {' executing...'}
          </Typography.Text>
        </Tag>
      ))}
    </Space>
  );
};

export default ToolExecutingIndicator;
