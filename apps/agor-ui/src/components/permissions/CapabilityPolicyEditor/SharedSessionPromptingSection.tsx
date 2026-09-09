import { Alert, Card, Flex, Switch, Typography, theme } from 'antd';

interface SharedSessionPromptingSectionProps {
  value: boolean;
  onChange: (value: boolean) => void;
  workspaceEnabled?: boolean;
  readOnly?: boolean;
  scope: 'board_defaults' | 'branch';
}

export const SharedSessionPromptingSection: React.FC<SharedSessionPromptingSectionProps> = ({
  value,
  onChange,
  workspaceEnabled = true,
  readOnly,
  scope,
}) => {
  const { token } = theme.useToken();
  const description =
    scope === 'board_defaults'
      ? 'Default for branches that inherit these settings.'
      : 'Allow branch Collaborators and Managers to continue sessions created by other people on this branch.';

  return (
    <Card size="small">
      <Flex vertical gap={token.paddingSM}>
        <Flex justify="space-between" align="center" gap={token.paddingMD} wrap>
          <Flex vertical gap={token.paddingXXS} style={{ flex: 1, minWidth: 240 }}>
            <Typography.Text strong>Allow shared session prompting</Typography.Text>
            <Typography.Text type="secondary">{description}</Typography.Text>
          </Flex>
          <Switch
            checked={value}
            disabled={!workspaceEnabled || readOnly}
            aria-label="Allow shared session prompting"
            onChange={onChange}
          />
        </Flex>

        {!workspaceEnabled && (
          <Alert
            type="info"
            showIcon
            description="Disabled in Workspace Preferences. An administrator must enable session sharing first."
          />
        )}

        {value && workspaceEnabled && (
          <Alert
            type="warning"
            showIcon
            description="People who can prompt a session can read its conversation and influence its future context. Prompts use the caller’s identity and credentials, while the conversation and branch SDK state are shared."
          />
        )}
      </Flex>
    </Card>
  );
};
