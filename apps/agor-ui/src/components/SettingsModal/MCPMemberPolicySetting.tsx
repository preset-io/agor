/**
 * The MCP member policy, shown where the servers it governs are listed.
 *
 * Members see it read-only rather than not at all: when a Connect button or an
 * edit is refused, this is the sentence that explains the refusal, and reading
 * it should not require an admin. They get the sentence and nothing else — a
 * row of permanently disabled radios offers a choice to someone who has none.
 *
 * Admins get the choice, folded away: the value in force is the line worth
 * standing above the table, and the three descriptions matter while deciding
 * and never again.
 */

import type { MCPMemberPolicy } from '@agor-live/client';
import { MCP_MEMBER_POLICIES } from '@agor-live/client';
import { Alert, Button, Flex, Radio, Skeleton, Space, Typography, theme } from 'antd';
import { useState } from 'react';
import { MCP_MEMBER_POLICY_DESCRIPTIONS } from '../MCPServer/memberPolicy';

const DESCRIPTION_ID_PREFIX = 'mcp-member-policy-';
const OPTIONS_ID = 'mcp-member-policy-options';
const TITLE = 'MCP member policy';

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
  const [expanded, setExpanded] = useState(false);
  const inForce = MCP_MEMBER_POLICY_DESCRIPTIONS[policy];
  // A value that is still loading, or that failed to load, is not this
  // workspace's policy — it is the restrictive value the UI acts on meanwhile.
  // Name none of them in force.
  const known = !loading && error === null;

  // The failure sits outside the fold: an admin must not have to open the
  // options to learn that the value above them was never read.
  const failure = error ? (
    <Alert type="error" showIcon title={error} style={{ marginBottom: token.marginXS }} />
  ) : null;

  if (!editable) {
    return (
      <div style={{ marginBottom: token.marginMD }}>
        {failure}
        {loading ? (
          <Skeleton active title={false} paragraph={{ rows: 1 }} />
        ) : (
          known && (
            <Typography.Text type="secondary">
              {TITLE}: <Typography.Text strong>{inForce.label}</Typography.Text> — {inForce.meaning}{' '}
              Only an admin can change it.
            </Typography.Text>
          )
        )}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: token.marginMD }}>
      {failure}
      <Flex align="center" gap={token.marginXS} wrap>
        <Typography.Text type="secondary">{TITLE}:</Typography.Text>
        {known ? (
          <Typography.Text strong>{inForce.label}</Typography.Text>
        ) : (
          loading && <Typography.Text type="secondary">Checking…</Typography.Text>
        )}
        <Button
          type="link"
          size="small"
          aria-expanded={expanded}
          aria-controls={OPTIONS_ID}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Hide' : 'Change'}
        </Button>
      </Flex>
      {expanded && (
        <div id={OPTIONS_ID} style={{ marginTop: token.marginSM }}>
          <Space orientation="vertical" size={token.marginSM} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              One setting for the whole workspace, not per user: it decides what members may do with
              MCP server configuration. Admins are unaffected by it, and accounts with read-only
              access configure nothing whatever it says.
            </Typography.Text>
            {loading ? (
              <Skeleton active paragraph={{ rows: 3 }} title={false} />
            ) : (
              <Radio.Group
                aria-label={TITLE}
                value={known ? policy : undefined}
                disabled={!known || saving}
                onChange={(event) => onChange(event.target.value as MCPMemberPolicy)}
              >
                <Space orientation="vertical" size={token.marginSM}>
                  {MCP_MEMBER_POLICIES.map((value) => (
                    // The meaning sits beside the radio rather than inside
                    // its label, so the option is named by its label and
                    // described by its sentence instead of announcing all
                    // of both.
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
            )}
          </Space>
        </div>
      )}
    </div>
  );
};
