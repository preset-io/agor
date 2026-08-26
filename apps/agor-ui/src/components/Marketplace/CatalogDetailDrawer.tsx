/**
 * Detail view for one catalog entry, and the only place a connect starts.
 *
 * The access disclosure is the first expanded details section and the connect
 * control stays disabled until it is acknowledged. AntD Collapse keeps the
 * disclosure keyboard-operable without weakening the server-side text match.
 */

import type {
  AgenticToolName,
  Branch,
  MCPCatalogCredentialRequirement,
  MCPCatalogEntry,
  MCPCatalogReadiness,
  SessionID,
} from '@agor/core/types';
import {
  ArrowRightOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Collapse,
  Descriptions,
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
import { VISUALLY_HIDDEN_STYLE } from '../../utils/accessibility';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import {
  canAddMcpServer,
  explainAddRestriction,
  type MCPServerCapabilityContext,
} from '../MCPServer/memberPolicy';
import {
  capabilityLabel,
  catalogAuthenticationDetail,
  connectStatus,
  entryTitle,
} from './catalogPresentation';
import { MARKETPLACE_CATALOG_DRAWER_WIDTH } from './marketplaceLayout';
import { type MarketplaceOAuthPopup, openMarketplaceOAuthPopup } from './marketplaceOAuthPopup';

const { Title, Paragraph, Text, Link } = Typography;

const DEFAULT_AGENT: AgenticToolName = 'claude-code';

const AGENT_OPTIONS = AVAILABLE_AGENTS.map((agent) => ({
  label: agent.name,
  value: agent.id,
}));

const FALLBACK_DISCLOSURE =
  'This server has published no access statement. Anything it exposes becomes available to the agent in the session you connect it to.';

export interface CatalogDetailDrawerProps {
  /** Authenticated identity that owns consent, selections, and pasted credentials. */
  identityKey: string | null;
  entry: MCPCatalogEntry | null;
  open: boolean;
  onClose: () => void;
  /** Restore focus to the catalog trigger after the drawer has actually closed. */
  onAfterOpenChange?: (open: boolean) => void;
  branches: Branch[];
  branchesLoading: boolean;
  branchesError: string | null;
  defaultBranchId: string | null;
  connecting: boolean;
  connectError: string | null;
  /**
   * What the live endpoint said it wanted, if a previous connect was refused
   * over the bearer access token. Overrides the entry's `auth_type` for deciding whether
   * the field is shown and required.
   *
   * The entry is a record of what was true when `curated.yaml` was last edited;
   * this is what the endpoint answered seconds ago. Where they disagree the
   * endpoint is right, and the form has to follow it — otherwise a stale entry
   * leaves the user holding a button that submits something the daemon will
   * refuse every time.
   */
  credentialRequirement?: MCPCatalogCredentialRequirement | null;
  /**
   * Connecting installs an MCP server, so the same server-provided capability
   * that gates Settings must gate this action too. Catalog browsing itself
   * remains available to every authenticated role.
   */
  connectCapability: MCPServerCapabilityContext;
  /** The policy read has not landed; fail closed without claiming a policy value. */
  policyPending: boolean;
  policyPendingHint: string;
  readiness?: MCPCatalogReadiness | null;
  readinessLoading?: boolean;
  readinessError?: string | null;
  success?: {
    sessionId: SessionID;
    sessionTitle?: string;
    branchName?: string;
    authentication: 'ready' | 'action_required' | 'pending' | 'failed' | 'unknown';
    reusedExistingServer: boolean;
  } | null;
  onOpenSession?: (sessionId: SessionID) => void;
  /** Continue surprise OAuth from a fresh direct user gesture. */
  onContinueOAuth?: (popup: MarketplaceOAuthPopup) => void;
  /**
   * `acknowledgedDisclosure` is the exact text this drawer put on screen, so
   * what the connect request claims was shown cannot drift from what was.
   *
   * `bearerToken` is present only for an entry that asks for one, and is the only
   * thing this drawer sends that the user typed. Everything else about the
   * server — where it is, how it is reached, what kind of credential it takes —
   * is the catalog's, resolved on the daemon from `catalog_key`.
   */
  onConnect: (input: {
    branchId: string;
    agenticTool: AgenticToolName;
    acknowledgedDisclosure: string;
    bearerToken?: string;
    oauthPopup?: MarketplaceOAuthPopup;
  }) => void;
}

const CatalogDetailDrawerForIdentity: React.FC<CatalogDetailDrawerProps> = ({
  identityKey: _identityKey,
  entry,
  open,
  onClose,
  onAfterOpenChange,
  branches,
  branchesLoading,
  branchesError,
  defaultBranchId,
  connecting,
  connectError,
  credentialRequirement,
  connectCapability,
  policyPending,
  policyPendingHint,
  readiness,
  readinessLoading = false,
  readinessError = null,
  success = null,
  onOpenSession,
  onContinueOAuth,
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

  const title = entry ? entryTitle(entry) : '';
  const connect = entry ? connectStatus(entry) : undefined;
  const readinessPresentation = (() => {
    switch (readiness?.state) {
      case 'no_auth':
        return {
          readiness: 'ready' as const,
          label: 'No account needed',
          detail: 'Connect in one step and try the starter prompt.',
        };
      case 'bearer_required':
        return {
          readiness: 'api-key' as const,
          label: 'Use your API key',
          detail: 'Verify a key from your own account before a session is created.',
        };
      case 'oauth_required':
        return {
          readiness: 'sign-in' as const,
          label: `Connect with ${title || 'provider'}`,
          detail: 'Sign in with your own account in a separate secure window.',
        };
      case 'installed_ready':
        return {
          readiness: 'ready' as const,
          label: 'Ready to use',
          detail: 'Your existing connection can be used in a new session.',
        };
      case 'reusable_oauth':
        return {
          readiness: 'ready' as const,
          label: 'Existing sign-in available',
          detail: 'Reuse your existing connection in a new session without signing in again.',
        };
      default:
        return connect;
    }
  })();
  const advisoryStatus = connect?.readiness === 'blocked' ? connect : readinessPresentation;
  const runtimeStatus = (() => {
    switch (credentialRequirement) {
      case 'required':
        return {
          readiness: 'api-key',
          label: 'Needs a bearer access token',
          detail: 'This endpoint requires the reviewed bearer-token scheme.',
        } as const;
      case 'oauth':
        return {
          readiness: 'sign-in',
          label: `Connect with ${title || 'provider'}`,
          detail:
            'The endpoint now requires OAuth. Connecting opens the provider sign-in automatically in a secure popup.',
        } as const;
      case 'not_accepted':
        return {
          readiness: 'ready',
          label: 'No account needed',
          detail: 'The endpoint is currently open and will not accept a pasted token.',
        } as const;
      case 'unsupported':
        return {
          readiness: 'blocked',
          label: 'Credential scheme not supported',
          detail:
            'This endpoint requires credentials, but Marketplace has no reviewed prescription for how to send them.',
        } as const;
      default:
        return advisoryStatus;
    }
  })();
  const blockedReason = runtimeStatus?.readiness === 'blocked' ? runtimeStatus.detail : undefined;
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
  const [popupBlocked, setPopupBlocked] = useState(false);

  // The endpoint's answer beats the catalog file's claim. `auth_type` decides
  // what the card promises before anything is dialled, which is all it can do;
  // once a connect has actually been refused, the daemon has told us what the
  // server asked for at that moment, and that is the thing to build the form
  // from. Absent — the ordinary case, including every first attempt — the entry
  // decides as before.
  const needsApiKey = runtimeStatus?.readiness === 'api-key';
  const keyField = pastedKey !== null && pastedKey.entryId === entryId ? pastedKey.value : '';
  const bearerToken = keyField.trim();

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
  // A successful connect now keeps the drawer open to show the next step, so it
  // must clear the key explicitly. A failed one deliberately does not: a user
  // who mistyped one character should not have to find the key again to correct
  // it — unless the endpoint has just said it wants no key at all, which ends
  // the need for that particular secret as surely as closing the drawer does.
  // Hiding the field while still holding what was typed in it would be the
  // retention bug again, one state further along.
  useEffect(() => {
    setPastedKey((held) =>
      open && !success && needsApiKey && held !== null && held.entryId === entryId ? held : null
    );
  }, [open, entryId, needsApiKey, success]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: both interaction boundaries clear a prior popup refusal
  useEffect(() => setPopupBlocked(false), [open, entryId]);

  const policyRefusal = policyPending
    ? policyPendingHint
    : canAddMcpServer(connectCapability)
      ? undefined
      : explainAddRestriction(connectCapability);
  const canConnect = Boolean(
    !blockedReason &&
      !policyRefusal &&
      acknowledged &&
      branchId &&
      !connecting &&
      (!needsApiKey || bearerToken)
  );
  const connectDisabledReason = connecting
    ? 'Connection in progress.'
    : !acknowledged
      ? 'Review the access disclosure and acknowledge it to continue.'
      : branchesLoading
        ? 'Loading branches…'
        : !branchId
          ? 'Choose an available branch to continue.'
          : needsApiKey && !bearerToken
            ? `Enter your ${title} bearer access token to continue.`
            : undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      afterOpenChange={onAfterOpenChange}
      size={MARKETPLACE_CATALOG_DRAWER_WIDTH}
      destroyOnHidden
      title={
        entry && (
          <Space align="center" size={token.marginSM}>
            <Avatar shape="square" size={40} src={entry.icon_url}>
              {title.charAt(0).toUpperCase()}
            </Avatar>
            <Flex vertical style={{ minWidth: 0 }}>
              <Text strong ellipsis>
                {title}
              </Text>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }} ellipsis>
                {entry.name}
              </Text>
            </Flex>
          </Space>
        )
      }
    >
      {entry && (
        <Flex vertical gap={token.margin}>
          <span role="status" aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN_STYLE}>
            {success?.authentication === 'ready'
              ? 'Connection status: Connected and ready.'
              : success?.authentication === 'action_required'
                ? 'Connection status: Continue to the provider to sign in.'
                : success?.authentication === 'failed'
                  ? 'Connection status: Sign-in not completed.'
                  : success?.authentication === 'unknown'
                    ? 'Connection status: Sign-in needs verification.'
                    : success?.authentication === 'pending'
                      ? 'Connection status: Sign-in pending.'
                      : ''}
          </span>
          <div>
            <Title level={4} style={{ marginTop: 0, marginBottom: token.marginXXS }}>
              {entry.benefit}
            </Title>
            {entry.description && (
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {entry.description}
              </Paragraph>
            )}
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

          {success ? (
            <Flex vertical gap={token.marginSM}>
              <Alert
                type={
                  success.authentication === 'ready'
                    ? 'success'
                    : success.authentication === 'action_required'
                      ? 'info'
                      : success.authentication === 'failed'
                        ? 'error'
                        : success.authentication === 'unknown'
                          ? 'warning'
                          : 'info'
                }
                showIcon
                title={
                  success.authentication === 'ready'
                    ? 'Connected and ready'
                    : success.authentication === 'action_required'
                      ? 'Sign in to continue'
                      : success.authentication === 'failed'
                        ? 'Sign-in not completed'
                        : success.authentication === 'unknown'
                          ? 'Sign-in needs verification'
                          : 'Sign-in pending'
                }
                description={
                  success.authentication === 'ready'
                    ? `${title} is attached to ${success.sessionTitle || 'your new session'}${success.branchName ? ` on ${success.branchName}` : ''}.`
                    : success.authentication === 'action_required'
                      ? `${title} requires OAuth. Continue to open the provider sign-in; no sign-in is pending yet.`
                      : success.authentication === 'failed'
                        ? `The session is available, but ${title} is not connected. Open it to retry through the MCP badge.`
                        : success.authentication === 'unknown'
                          ? `Agor could not verify the final ${title} sign-in result. Open the session to check or retry through the MCP badge.`
                          : `Complete ${title} sign-in in the provider window. Agor will show success only after the saved grant is confirmed.`
                }
                action={
                  success.authentication === 'action_required' ? (
                    <Flex gap={token.marginXS} wrap>
                      <Button
                        type="primary"
                        loading={connecting}
                        disabled={!onContinueOAuth}
                        onClick={() => {
                          if (!onContinueOAuth) return;
                          const opened = openMarketplaceOAuthPopup();
                          if (!opened) {
                            setPopupBlocked(true);
                            return;
                          }
                          setPopupBlocked(false);
                          onContinueOAuth(opened);
                        }}
                      >
                        Continue to provider
                      </Button>
                      <Button
                        type="link"
                        aria-label="Open session"
                        icon={<ArrowRightOutlined />}
                        onClick={() => onOpenSession?.(success.sessionId)}
                      >
                        Open session
                      </Button>
                    </Flex>
                  ) : (
                    <Button
                      type="primary"
                      aria-label="Open session"
                      icon={<ArrowRightOutlined />}
                      onClick={() => onOpenSession?.(success.sessionId)}
                    >
                      Open session
                    </Button>
                  )
                }
              />
              {success.reusedExistingServer && (
                <Alert
                  type="info"
                  showIcon
                  title="Your existing connection was reused"
                  description="No duplicate server was installed; the new session uses the connection you already had."
                />
              )}
            </Flex>
          ) : runtimeStatus && runtimeStatus.readiness !== 'blocked' ? (
            <Alert
              type={runtimeStatus.readiness === 'ready' ? 'success' : 'info'}
              showIcon
              title={runtimeStatus.label}
              description={runtimeStatus.detail}
            />
          ) : null}
          {popupBlocked && (
            <Alert
              type="error"
              showIcon
              title="Allow popups to connect this account"
              description={
                success?.authentication === 'action_required'
                  ? 'Sign-in has not started. Allow popups, then continue to the provider again.'
                  : 'Nothing was connected because the sign-in window could not be opened.'
              }
            />
          )}
          {!success && readinessError && (
            <Alert
              type="warning"
              showIcon
              title="Saved connection status is unavailable"
              description="Connect will recheck safely before it uses or creates anything."
            />
          )}

          <Collapse
            defaultActiveKey={['access']}
            items={[
              {
                key: 'access',
                label: (
                  <Space size={token.marginXS}>
                    <SafetyCertificateOutlined />
                    <Text strong>What this can access</Text>
                  </Space>
                ),
                children: (
                  <Flex vertical gap={token.marginSM}>
                    <Text>{disclosure}</Text>
                    {!blockedReason && !success && (
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
                ),
              },
              {
                key: 'technical',
                label: <Text strong>Technical details</Text>,
                children: (
                  <Descriptions
                    size="small"
                    column={1}
                    items={[
                      {
                        key: 'identity',
                        label: 'Catalog ID',
                        children: <Text copyable>{entry.name}</Text>,
                      },
                      {
                        key: 'transport',
                        label: 'Transport',
                        children: entry.transport ?? 'Not stated',
                      },
                      {
                        key: 'authentication',
                        label: 'Authentication',
                        children: catalogAuthenticationDetail(
                          entry.auth_type,
                          credentialRequirement
                        ),
                      },
                      {
                        key: 'tools',
                        label: 'Tools',
                        children: 'Discovered from the server after connection',
                      },
                    ]}
                  />
                ),
              },
            ]}
          />

          {success ? null : blockedReason ? (
            <Alert type="info" showIcon title={blockedReason} />
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
                    label={entry.credentials?.label ?? 'Bearer access token'}
                    required
                    style={{ marginBottom: 0 }}
                    // The two things a user needs and the entry can supply:
                    // whose key this is, and where to go and get one. Without
                    // the first, "bearer access token" is ambiguous on a page that also
                    // mentions Agor; without the second, the answer is a search
                    // engine. `website_url` is the vendor's own page, so it is
                    // the honest place to send someone — the marketplace does
                    // not know each vendor's settings URL and guessing one
                    // would rot silently.
                    extra={
                      <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        Your own {title} bearer access token. It is stored for you alone and never
                        shown again.
                        {entry.credentials?.acquisition_url && (
                          <>
                            {' '}
                            <Link
                              href={entry.credentials.acquisition_url}
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
                      placeholder={`Paste your ${title} bearer access token`}
                      autoComplete="off"
                      // The browser is the one place this drawer cannot promise
                      // anything about: an autofilled or remembered value here
                      // is a credential kept somewhere Agor does not manage.
                      spellCheck={false}
                    />
                  </Form.Item>
                )}
              </Form>

              {branchesError && <Alert type="error" showIcon title={branchesError} />}
              {connectError && <Alert type="error" showIcon title={connectError} />}
              {policyRefusal && <Alert type="info" showIcon title={policyRefusal} />}

              <Button
                type="primary"
                block
                icon={<ThunderboltOutlined />}
                loading={connecting}
                disabled={!canConnect}
                onClick={() => {
                  if (!branchId) return;
                  let oauthPopup: MarketplaceOAuthPopup | undefined;
                  const hasLiveCredentialRequirement = credentialRequirement != null;
                  const needsOAuthWindow =
                    credentialRequirement === 'oauth' ||
                    (!hasLiveCredentialRequirement &&
                      (readinessLoading ||
                        !readiness ||
                        Boolean(readinessError) ||
                        entry.auth_type === 'oauth' ||
                        readiness?.state === 'oauth_required' ||
                        readiness?.state === 'reusable_oauth'));
                  if (needsOAuthWindow) {
                    const opened = openMarketplaceOAuthPopup();
                    if (!opened) {
                      setPopupBlocked(true);
                      return;
                    }
                    oauthPopup = opened;
                  }
                  setPopupBlocked(false);
                  onConnect({
                    branchId,
                    agenticTool,
                    acknowledgedDisclosure: disclosure,
                    // Only for an entry that asks. Sending a key to an endpoint
                    // that never wanted one is refused by the daemon, and the
                    // field it would have come from is not rendered anyway.
                    ...(needsApiKey ? { bearerToken } : {}),
                    ...(oauthPopup ? { oauthPopup } : {}),
                  });
                }}
              >
                {runtimeStatus?.readiness === 'sign-in'
                  ? `Connect with ${title}`
                  : runtimeStatus?.readiness === 'api-key'
                    ? 'Verify key & connect'
                    : credentialRequirement == null &&
                        (readiness?.state === 'installed_ready' ||
                          readiness?.state === 'reusable_oauth')
                      ? 'Use in a new session'
                      : runtimeStatus?.readiness === 'unchecked'
                        ? 'Check & connect'
                        : 'Connect & try it'}
              </Button>
              <Text
                type="secondary"
                role="status"
                aria-live="polite"
                style={{ fontSize: token.fontSizeSM }}
              >
                {connectDisabledReason ??
                  (runtimeStatus?.readiness === 'sign-in'
                    ? `Opens ${title}'s sign-in popup and a recoverable new session; its starter prompt appears after sign-in succeeds.`
                    : runtimeStatus?.readiness === 'unchecked'
                      ? `Checks ${title}'s live authentication requirement before opening a session.`
                      : `Opens a new session on that branch with ${title} attached and a starter prompt ready to send.`)}
              </Text>
            </Flex>
          )}
        </Flex>
      )}
    </Drawer>
  );
};

/**
 * Consent, branch/agent selections, and bearer credentials are caller-entered
 * authority. A keyed state owner destroys all of them during the A -> B render,
 * including the same-role/same-entry case that entry-keying alone cannot see.
 * Connection/auth-generation churn for one identity deliberately keeps them.
 */
export const CatalogDetailDrawer: React.FC<CatalogDetailDrawerProps> = (props) => (
  <CatalogDetailDrawerForIdentity
    key={props.identityKey ?? '__no-authenticated-user__'}
    {...props}
  />
);
