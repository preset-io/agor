import { AGENTIC_TOOL_DISPLAY_NAMES, AGENTIC_TOOL_KEY_CREATION_URL } from '@agor/agentic-tools';
import type { AgenticToolName } from '@agor-live/client';
import { Button, Space, Typography, theme } from 'antd';
import type React from 'react';
import { SystemMessage } from '../SystemMessage';

const { Text, Link } = Typography;

export interface ProviderBillingRecoveryPanelProps {
  tool: AgenticToolName;
  /** Opens Settings deep-linked to this tool's Agentic Tools tab. */
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
}

export const ProviderBillingRecoveryPanel: React.FC<ProviderBillingRecoveryPanelProps> = ({
  tool,
  onOpenAgenticToolSettings,
}) => {
  const { token } = theme.useToken();
  const displayName = AGENTIC_TOOL_DISPLAY_NAMES[tool] ?? tool;
  const accountUrl = AGENTIC_TOOL_KEY_CREATION_URL[tool];

  return (
    <SystemMessage
      content={
        <div style={{ maxWidth: 480 }}>
          <Text style={{ fontSize: 13 }}>
            The {displayName} account used for this run needs available credit or quota. Your
            workspace and teammate are still set up. Check your settings or provider console, then
            send a new message.
          </Text>

          <div style={{ marginTop: token.marginSM }}>
            <Button
              type="primary"
              onClick={() => onOpenAgenticToolSettings?.(tool)}
              disabled={!onOpenAgenticToolSettings}
            >
              Open {displayName} settings
            </Button>
          </div>

          {accountUrl && (
            <Space orientation="vertical" size={4} style={{ marginTop: token.marginSM }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Need to update your account?{' '}
                <Link
                  href={accountUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 12 }}
                >
                  Open {displayName}'s console →
                </Link>
              </Text>
            </Space>
          )}
        </div>
      }
    />
  );
};
