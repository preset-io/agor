/**
 * Recovery state for a provider that accepted the connection but rejected the
 * request because its balance or usage quota is unavailable.
 */

import { AGENTIC_TOOL_DISPLAY_NAMES, AGENTIC_TOOL_KEY_CREATION_URL } from '@agor/agentic-tools';
import type { AgenticToolName } from '@agor-live/client';
import { Button, Space, Typography, theme } from 'antd';
import { SystemMessage } from '../SystemMessage';

const { Text, Link } = Typography;

export interface ProviderCreditExhaustedPanelProps {
  tool: AgenticToolName;
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
}

export const ProviderCreditExhaustedPanel: React.FC<ProviderCreditExhaustedPanelProps> = ({
  tool,
  onOpenAgenticToolSettings,
}) => {
  const { token } = theme.useToken();
  const displayName = AGENTIC_TOOL_DISPLAY_NAMES[tool] ?? tool;
  const providerAccountUrl = AGENTIC_TOOL_KEY_CREATION_URL[tool];

  return (
    <SystemMessage
      agenticTool={tool}
      content={
        <div style={{ maxWidth: 520 }}>
          <Text style={{ fontSize: 13 }}>
            Your {displayName} connection is present, but the model provider has no available
            balance or usage quota for this request.
          </Text>

          <Text
            type="secondary"
            style={{ display: 'block', fontSize: 13, marginTop: token.marginSM }}
          >
            Add credits or increase the provider quota, or switch to another connected provider or
            account. Your AI teammate and workspace are still set up. After fixing the provider,
            send a new message.
          </Text>

          <Space orientation="vertical" size={4} style={{ marginTop: token.marginSM }}>
            <Button
              type="primary"
              onClick={() => onOpenAgenticToolSettings?.(tool)}
              disabled={!onOpenAgenticToolSettings}
            >
              Open {displayName} settings
            </Button>
            {providerAccountUrl && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                Review your provider balance or quota:{' '}
                <Link
                  href={providerAccountUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 12 }}
                >
                  Open {displayName} account →
                </Link>
              </Text>
            )}
          </Space>
        </div>
      }
    />
  );
};
