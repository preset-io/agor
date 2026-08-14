/**
 * Detail view for one catalog entry, and the only place a connect starts.
 *
 * `REQ-SEC-1`: the "What this can access" disclosure is rendered expanded, is
 * not collapsible, and sits between the user and the connect control — which
 * stays disabled until it is acknowledged. Reading it is the last thing that
 * happens before a server the agent will obey gets attached to a session, so it
 * is a gate rather than a panel.
 */

import type { AgenticToolName, Branch, MCPCatalogEntry } from '@agor/core/types';
import { ThunderboltOutlined } from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Drawer,
  Flex,
  Form,
  Select,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import { capabilityLabel, connectStatus, entryTitle } from './catalogPresentation';

const { Title, Paragraph, Text, Link } = Typography;

const DEFAULT_AGENT: AgenticToolName = 'claude-code';

const AGENT_OPTIONS = AVAILABLE_AGENTS.map((agent) => ({
  label: agent.name,
  value: agent.id,
}));

const FALLBACK_DISCLOSURE =
  'This server has published no access statement. Anything it exposes becomes available to the agent in the session you connect it to.';

export interface CatalogDetailDrawerProps {
  entry: MCPCatalogEntry | null;
  open: boolean;
  onClose: () => void;
  branches: Branch[];
  branchesLoading: boolean;
  branchesError: string | null;
  defaultBranchId: string | null;
  connecting: boolean;
  connectError: string | null;
  /**
   * `acknowledgedDisclosure` is the exact text this drawer put on screen, so
   * what the connect request claims was shown cannot drift from what was.
   */
  onConnect: (input: {
    branchId: string;
    agenticTool: AgenticToolName;
    acknowledgedDisclosure: string;
  }) => void;
}

export const CatalogDetailDrawer: React.FC<CatalogDetailDrawerProps> = ({
  entry,
  open,
  onClose,
  branches,
  branchesLoading,
  branchesError,
  defaultBranchId,
  connecting,
  connectError,
  onConnect,
}) => {
  const { token } = theme.useToken();
  const [branchId, setBranchId] = useState<string | undefined>();
  const [agenticTool, setAgenticTool] = useState<AgenticToolName>(DEFAULT_AGENT);

  const entryId = entry?.name;

  const branchOptions = useMemo(
    () =>
      branches.map((branch) => ({
        label: branch.name as string,
        value: branch.branch_id as string,
      })),
    [branches]
  );

  useEffect(() => {
    if (branchId && branchOptions.some((option) => option.value === branchId)) return;
    const preferred =
      defaultBranchId && branchOptions.some((option) => option.value === defaultBranchId)
        ? defaultBranchId
        : branchOptions[0]?.value;
    setBranchId(preferred);
  }, [branchOptions, defaultBranchId, branchId]);

  const connect = entry ? connectStatus(entry) : undefined;
  const blockedReason = connect?.readiness === 'blocked' ? connect.detail : undefined;
  const title = entry ? entryTitle(entry) : '';
  const disclosure = entry?.permission_disclosure ?? FALLBACK_DISCLOSURE;

  // Consent records the server *and* the words it was given for, rather than a
  // boolean some effect resets. A boolean leaves one render in which a newly
  // opened server's disclosure sits above an already-enabled button; keying on
  // the server alone still lets a re-opened entry arrive pre-consented after
  // curation rewrote what it discloses. The endpoint's contract is the text, so
  // this is too.
  const [consent, setConsent] = useState<{ entryId: string; disclosure: string } | null>(null);
  const acknowledged =
    entryId !== undefined && consent?.entryId === entryId && consent.disclosure === disclosure;
  const canConnect = Boolean(!blockedReason && acknowledged && branchId && !connecting);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={480}
      destroyOnHidden
      title={
        entry && (
          <Space align="center">
            <Avatar shape="square" src={entry.icon_url}>
              {title.charAt(0).toUpperCase()}
            </Avatar>
            <Text strong>{title}</Text>
          </Space>
        )
      }
    >
      {entry && (
        <Flex vertical gap={token.margin}>
          <div>
            <Title level={4} style={{ marginTop: 0, marginBottom: token.marginXXS }}>
              {entry.benefit}
            </Title>
            {entry.description && (
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {entry.description}
              </Paragraph>
            )}
            <Text type="secondary" copyable style={{ fontSize: token.fontSizeSM }}>
              {entry.name}
            </Text>
          </div>

          {entry.website_url && (
            <Link href={entry.website_url} target="_blank" rel="noopener noreferrer">
              Website
            </Link>
          )}

          {entry.capabilities.length > 0 && (
            <div>
              <Text strong>What you can do</Text>
              <Space
                size={[token.marginXXS, token.marginXXS]}
                wrap
                style={{ marginTop: token.marginXS }}
              >
                {entry.capabilities.map((capability) => (
                  <Tag key={capability} color="processing" style={{ marginInlineEnd: 0 }}>
                    {capabilityLabel(capability)}
                  </Tag>
                ))}
              </Space>
            </div>
          )}

          {connect && connect.readiness !== 'blocked' && (
            <Alert
              type={connect.readiness === 'ready' ? 'success' : 'info'}
              showIcon
              message={connect.label}
              description={connect.detail}
            />
          )}

          <Alert
            type="warning"
            showIcon
            message="What this can access"
            description={
              <Flex vertical gap={token.marginXS}>
                <Text>{disclosure}</Text>
                {!blockedReason && (
                  <Checkbox
                    checked={acknowledged}
                    onChange={(event) =>
                      setConsent(
                        event.target.checked && entryId !== undefined
                          ? { entryId, disclosure }
                          : null
                      )
                    }
                  >
                    I understand what this server can access
                  </Checkbox>
                )}
              </Flex>
            }
          />

          {blockedReason ? (
            <Alert type="info" showIcon message={blockedReason} />
          ) : (
            <Flex vertical gap={token.marginXS}>
              <Form layout="vertical" size="middle" component="div">
                <Form.Item label="Branch" style={{ marginBottom: token.marginXS }}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    loading={branchesLoading}
                    value={branchId}
                    onChange={setBranchId}
                    options={branchOptions}
                    placeholder={branchesLoading ? 'Loading branches…' : 'Select a branch'}
                    notFoundContent={branchesLoading ? 'Loading branches…' : 'No branches yet'}
                  />
                </Form.Item>
                <Form.Item label="Agent" style={{ marginBottom: 0 }}>
                  <Select<AgenticToolName>
                    value={agenticTool}
                    onChange={setAgenticTool}
                    options={AGENT_OPTIONS}
                  />
                </Form.Item>
              </Form>

              {branchesError && <Alert type="error" showIcon message={branchesError} />}
              {connectError && <Alert type="error" showIcon message={connectError} />}

              <Button
                type="primary"
                block
                icon={<ThunderboltOutlined />}
                loading={connecting}
                disabled={!canConnect}
                onClick={() =>
                  branchId &&
                  onConnect({ branchId, agenticTool, acknowledgedDisclosure: disclosure })
                }
              >
                Connect &amp; try it
              </Button>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                Opens a new session on that branch with {title} attached and a starter prompt ready
                to send.
              </Text>
            </Flex>
          )}
        </Flex>
      )}
    </Drawer>
  );
};
