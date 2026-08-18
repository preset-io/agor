/**
 * The MCP member policy: one tenant-wide setting for what members may do with
 * MCP server configuration.
 *
 * Members read it rather than not see it at all: when a Connect button or an
 * edit is refused, this is the sentence that explains the refusal, and reading
 * it should not require an admin. They get the sentence alone — a row of
 * permanently disabled radios offers a choice to someone who has none.
 */

import type { MCPMemberPolicy } from '@agor-live/client';
import { MCP_MEMBER_POLICIES } from '@agor-live/client';
import { Alert, Radio, Skeleton, Space, Typography, theme } from 'antd';
import { MCP_MEMBER_POLICY_DESCRIPTIONS } from '../MCPServer/memberPolicy';

const DESCRIPTION_ID_PREFIX = 'mcp-member-policy-';

export interface MCPMemberPolicySettingProps {
  policy: MCPMemberPolicy;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Admins may change the value; everyone else reads it. */
  editable: boolean;
  onChange: (next: MCPMemberPolicy) => void;
}

export const MCPMemberPolicySetting: React.FC<MCPMemberPolicySettingProps> = ({
  policy,
  loading,
  saving,
  error,
  editable,
  onChange,
}) => {
  const { token } = theme.useToken();
  const inForce = MCP_MEMBER_POLICY_DESCRIPTIONS[policy];
  // A value that is still loading, or that failed to load, is not this
  // workspace's policy — it is the restrictive value the UI acts on meanwhile.
  // Name none of them in force.
  const known = !loading && error === null;

  return (
    <Space
      orientation="vertical"
      size={token.marginMD}
      // Prose reads badly across a full settings pane; hold it to a column.
      style={{ width: '100%', maxWidth: 720 }}
    >
      {error && <Alert type="error" showIcon title={error} />}
      {editable && (
        <Typography.Text type="secondary">
          One setting for the whole workspace, not per user: it decides what members may do with MCP
          server configuration. Admins are unaffected by it, and accounts with read-only access
          configure nothing whatever it says.
        </Typography.Text>
      )}
      {loading ? (
        <Skeleton active paragraph={{ rows: editable ? 3 : 1 }} title={false} />
      ) : editable ? (
        <Radio.Group
          aria-label="MCP member policy"
          value={known ? policy : undefined}
          disabled={!known || saving}
          onChange={(event) => onChange(event.target.value as MCPMemberPolicy)}
        >
          <Space orientation="vertical" size={token.marginSM}>
            {MCP_MEMBER_POLICIES.map((value) => (
              // The meaning sits beside the radio rather than inside its label,
              // so the option is named by its label and described by its
              // sentence instead of announcing all of both.
              <div key={value}>
                <Radio value={value} aria-describedby={`${DESCRIPTION_ID_PREFIX}${value}`}>
                  <Typography.Text strong>
                    {MCP_MEMBER_POLICY_DESCRIPTIONS[value].label}
                  </Typography.Text>
                </Radio>
                <Typography.Paragraph
                  id={`${DESCRIPTION_ID_PREFIX}${value}`}
                  type="secondary"
                  style={{ marginBottom: 0, paddingInlineStart: token.paddingLG }}
                >
                  {MCP_MEMBER_POLICY_DESCRIPTIONS[value].meaning}
                </Typography.Paragraph>
              </div>
            ))}
          </Space>
        </Radio.Group>
      ) : (
        known && (
          <Typography.Text type="secondary">
            In force: <Typography.Text strong>{inForce.label}</Typography.Text> — {inForce.meaning}{' '}
            Only an admin can change it.
          </Typography.Text>
        )
      )}
    </Space>
  );
};
