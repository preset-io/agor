/**
 * Detail view for one catalog entry, and the only place a connect starts.
 *
 * `REQ-SEC-1`: the "What this can access" disclosure is rendered expanded, is
 * not collapsible, and sits between the user and the connect control — which
 * stays disabled until it is acknowledged. Reading it is the last thing that
 * happens before a server the agent will obey gets attached to a session, so it
 * is a gate rather than a panel.
 */

import type {
  AgenticToolName,
  Branch,
  MCPCatalogApiKeyRequirement,
  MCPCatalogEntry,
} from '@agor/core/types';
import { ThunderboltOutlined } from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Drawer,
  Flex,
  Form,
  Input,
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
   * What the live endpoint said it wanted, if a previous connect was refused
   * over the API key. Overrides the entry's `auth_type` for deciding whether
   * the field is shown and required.
   *
   * The entry is a record of what was true when `curated.yaml` was last edited;
   * this is what the endpoint answered seconds ago. Where they disagree the
   * endpoint is right, and the form has to follow it — otherwise a stale entry
   * leaves the user holding a button that submits something the daemon will
   * refuse every time.
   */
  apiKeyRequirement?: MCPCatalogApiKeyRequirement | null;
  /**
   * `acknowledgedDisclosure` is the exact text this drawer put on screen, so
   * what the connect request claims was shown cannot drift from what was.
   *
   * `apiKey` is present only for an entry that asks for one, and is the only
   * thing this drawer sends that the user typed. Everything else about the
   * server — where it is, how it is reached, what kind of credential it takes —
   * is the catalog's, resolved on the daemon from `catalog_key`.
   */
  onConnect: (input: {
    branchId: string;
    agenticTool: AgenticToolName;
    acknowledgedDisclosure: string;
    apiKey?: string;
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
  apiKeyRequirement,
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

  // Keyed by entry for the same reason consent is, and more sharply: a bare
  // string would survive switching entries in an open drawer, leaving one
  // vendor's key sitting in the field for a connect to another vendor's
  // endpoint. Pairing it with the entry it was typed for means the field is
  // empty for any entry it was not.
  const [pastedKey, setPastedKey] = useState<{ entryId: string; value: string } | null>(null);

  // The endpoint's answer beats the catalog file's claim. `auth_type` decides
  // what the card promises before anything is dialled, which is all it can do;
  // once a connect has actually been refused, the daemon has told us what the
  // server asked for at that moment, and that is the thing to build the form
  // from. Absent — the ordinary case, including every first attempt — the entry
  // decides as before.
  const needsApiKey =
    apiKeyRequirement != null ? apiKeyRequirement === 'required' : connect?.readiness === 'api-key';
  const keyField = pastedKey !== null && pastedKey.entryId === entryId ? pastedKey.value : '';
  const apiKey = keyField.trim();

  // Discard the key when the interaction that needed it ends — the drawer
  // closing, or a different entry being shown.
  //
  // The keying above decides what renders; this decides what is held. They are
  // not the same question, and answering only the first left a secret in React
  // state for the rest of the page's life. `destroyOnHidden` does not cover it:
  // it unmounts the drawer's *contents* — the `Input.Password` and its reveal
  // toggle — while this component stays mounted for as long as the Marketplace
  // is open, so a key pasted and then abandoned came back, visible, on
  // reopening the same entry.
  //
  // A successful connect closes the drawer, so it clears here too rather than
  // needing its own path. A failed one deliberately does not: the drawer stays
  // open, and a user who mistyped one character should not have to find the key
  // again to correct it — unless the endpoint has just said it wants no key at
  // all, which ends the need for that particular secret as surely as closing
  // the drawer does. Hiding the field while still holding what was typed in it
  // would be the retention bug again, one state further along.
  useEffect(() => {
    setPastedKey((held) =>
      open && needsApiKey && held !== null && held.entryId === entryId ? held : null
    );
  }, [open, entryId, needsApiKey]);

  const canConnect = Boolean(
    !blockedReason && acknowledged && branchId && !connecting && (!needsApiKey || apiKey)
  );

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
                <Form.Item label="Agent" style={{ marginBottom: needsApiKey ? token.marginXS : 0 }}>
                  <Select<AgenticToolName>
                    value={agenticTool}
                    onChange={setAgenticTool}
                    options={AGENT_OPTIONS}
                  />
                </Form.Item>
                {needsApiKey && (
                  <Form.Item
                    label="API key"
                    required
                    style={{ marginBottom: 0 }}
                    // The two things a user needs and the entry can supply:
                    // whose key this is, and where to go and get one. Without
                    // the first, "API key" is ambiguous on a page that also
                    // mentions Agor; without the second, the answer is a search
                    // engine. `website_url` is the vendor's own page, so it is
                    // the honest place to send someone — the marketplace does
                    // not know each vendor's settings URL and guessing one
                    // would rot silently.
                    extra={
                      <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        Your own {title} API key. It is stored for you alone and never shown again —
                        reconnect with a new one to rotate it.
                        {entry.website_url && (
                          <>
                            {' '}
                            <Link
                              href={entry.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Where to find it
                            </Link>
                          </>
                        )}
                      </Text>
                    }
                  >
                    <Input.Password
                      value={keyField}
                      onChange={(event) =>
                        setPastedKey(
                          entryId === undefined ? null : { entryId, value: event.target.value }
                        )
                      }
                      placeholder={`Paste your ${title} API key`}
                      autoComplete="off"
                      // The browser is the one place this drawer cannot promise
                      // anything about: an autofilled or remembered value here
                      // is a credential kept somewhere Agor does not manage.
                      spellCheck={false}
                    />
                  </Form.Item>
                )}
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
                  onConnect({
                    branchId,
                    agenticTool,
                    acknowledgedDisclosure: disclosure,
                    // Only for an entry that asks. Sending a key to an endpoint
                    // that never wanted one is refused by the daemon, and the
                    // field it would have come from is not rendered anyway.
                    ...(needsApiKey ? { apiKey } : {}),
                  })
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
