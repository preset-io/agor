/**
 * ToolExecutingIndicator Component
 *
 * Shows real-time indicators when tools are being executed by the agent.
 * Displays a list of currently executing tools with visual feedback.
 */

import { CheckCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import { Space, Tag, Typography } from 'antd';
import type { ToolExecution } from '../../hooks/useTaskEvents';

interface ToolExecutingIndicatorProps {
  toolsExecuting: ToolExecution[];
}

/**
 * Component to display real-time tool execution status
 *
 * Shows a list of tools that are currently executing or recently completed.
 * Each tool is displayed with:
 * - Tool name
 * - Execution status (executing = spinner, complete = checkmark)
 * - Color coding (blue = executing, green = complete)
 */
const ToolExecutingIndicator = ({ toolsExecuting }: ToolExecutingIndicatorProps) => {
  if (toolsExecuting.length === 0) {
    return null;
  }

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {toolsExecuting.map((tool) => (
        <Tag
          key={tool.toolUseId}
          icon={tool.status === 'executing' ? <LoadingOutlined spin /> : <CheckCircleOutlined />}
          color={tool.status === 'executing' ? 'processing' : 'success'}
          style={{ margin: 0 }}
        >
          <Typography.Text style={{ fontSize: 12 }}>
            {tool.toolName}
            {tool.status === 'executing' ? ' executing...' : ' complete'}
          </Typography.Text>
        </Tag>
      ))}
    </Space>
  );
};

export default ToolExecutingIndicator;
