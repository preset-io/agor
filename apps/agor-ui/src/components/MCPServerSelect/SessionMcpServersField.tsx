import type { MCPServer } from '@agor-live/client';
import { Form } from 'antd';
import { useServiceReadable } from '@/hooks/useServicesConfig';
import { mapToArray } from '@/utils/mapHelpers';
import { MCPServerSelect } from './MCPServerSelect';

export interface SessionMcpServersFieldProps {
  mcpServerById: Map<string, MCPServer>;
  showHelpText?: boolean;
}

/**
 * MCP servers picker as a first-class form field.
 *
 * Bundles the readability gate (`mcp_servers` service tier) and the
 * `Form.Item` shell so callers (NewSessionModal, AgenticToolConfigForm, …)
 * can drop a single component wherever they need MCP selection — primary
 * zone or collapsed advanced section — without duplicating the gate.
 */
export const SessionMcpServersField: React.FC<SessionMcpServersFieldProps> = ({
  mcpServerById,
  showHelpText = false,
}) => {
  const mcpReadable = useServiceReadable('mcp_servers');
  if (!mcpReadable) return null;

  return (
    <Form.Item
      name="mcpServerIds"
      label="MCP Servers"
      help={showHelpText ? 'Select MCP servers to make available in this session' : undefined}
    >
      <MCPServerSelect
        mcpServers={mapToArray(mcpServerById)}
        placeholder="No MCP servers attached"
      />
    </Form.Item>
  );
};
