/**
 * Detail view for one catalog entry, and the only place a connect starts.
 *
 * The access disclosure is the first expanded details section and the connect
 * control stays disabled until it is acknowledged. The disclosure controls
 * remain keyboard-operable without weakening the server-side text match.
 */

import type {
  AgenticToolName,
  Branch,
  BranchID,
  MCPCatalogCredentialRequirement,
  MCPCatalogEntry,
  MCPCatalogReadiness,
} from '@agor/core/types';
import { getTeammateConfig } from '@agor-live/client';
import {
  CheckCircleFilled,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Flex,
  Form,
  Input,
  Select,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { VISUALLY_HIDDEN_STYLE } from '../../utils/accessibility';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import {
  canAddMcpServer,
  explainAddRestriction,
  type MCPServerCapabilityContext,
} from '../MCPServer/memberPolicy';
import { CatalogDetailSection } from './CatalogDetailSection';
import { CatalogDrawer } from './CatalogDrawer';
import { CatalogEntryAvatar } from './CatalogEntryAvatar';
import {
  capabilityLabel,
  catalogAuthenticationDetail,
  connectStatus,
  entryTitle,
} from './catalogPresentation';
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
  /** In-place loading/error content before an entry resolves; the drawer stays mounted. */
  emptyContent?: ReactNode;
  onClose: () => void;
  /** Restore focus to the catalog trigger after the drawer has actually closed. */
  onAfterOpenChange?: (open: boolean) => void;
  teammates: Branch[];
  teammatesLoading: boolean;
  teammatesError: string | null;
  defaultTeammateId: BranchID | null;
  connecting: boolean;
  startingSession: boolean;
  startSessionError: string | null;
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
    catalogKey: string;
    serverId: string;
    starterPrompt?: string;
    authentication: 'ready' | 'action_required' | 'pending' | 'failed' | 'unknown';
    reusedExistingServer: boolean;
  } | null;
  onKeepBrowsing?: () => void;
  onBeginSessionSetup?: () => void;
  onStartSession?: (input: { teammateBranchId: BranchID; agenticTool: AgenticToolName }) => void;
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
  emptyContent,
  onAfterOpenChange,
  teammates,
  teammatesLoading,
  teammatesError,
  defaultTeammateId,
  connecting,
  startingSession,
  startSessionError,
  connectError,
  credentialRequirement,
  connectCapability,
  policyPending,
  policyPendingHint,
  readiness,
  readinessLoading = false,
  readinessError = null,
  success = null,
  onKeepBrowsing,
  onBeginSessionSetup,
  onStartSession,
  onContinueOAuth,
  onConnect,
}) => {
  const { token } = theme.useToken();
  const titleId = useId();
  const successActionRef = useRef<HTMLButtonElement | null>(null);
  const [teammateId, setTeammateId] = useState<BranchID | undefined>();
  const [agenticTool, setAgenticTool] = useState<AgenticToolName>(DEFAULT_AGENT);
  const [showSessionSetup, setShowSessionSetup] = useState(false);

  const entryId = entry?.name;

  const teammateOptions = useMemo(
    () =>
      teammates.map((teammate) => ({
        label: getTeammateConfig(teammate)?.displayName ?? teammate.name,
        value: teammate.branch_id,
      })),
    [teammates]
  );

  useEffect(() => {
    if (teammateId && teammateOptions.some((option) => option.value === teammateId)) return;
    const preferred =
      defaultTeammateId && teammateOptions.some((option) => option.value === defaultTeammateId)
        ? (defaultTeammateId as BranchID)
        : teammateOptions[0]?.value;
    setTeammateId(preferred);
  }, [teammateOptions, defaultTeammateId, teammateId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching entry/install resets staged setup
  useEffect(() => setShowSessionSetup(false), [entryId, success?.serverId]);

  useEffect(() => {
    if (!open || !success) return;
    // The Connect button is removed when the success panel replaces the form.
    // Defer until that commit and rc-drawer's own focus bookkeeping settle, so
    // focus lands on the truthful next step instead of falling back to body.
    const timer = window.setTimeout(() => successActionRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, success]);

  const title = entry ? entryTitle(entry) : '';
  const connect = entry ? connectStatus(entry) : undefined;
  const readinessPresentation = (() => {
    switch (readiness?.state) {
      case 'no_auth':
        return {
          readiness: 'unchecked' as const,
          label: 'No account expected',
          detail:
            'Catalog and saved connection data indicate no account is needed. Agor checks the endpoint when you connect.',
        };
      case 'bearer_required': {
        const credentialName =
          entry?.credentials?.label?.trim().toLocaleLowerCase() ?? 'bearer access token';
        return {
          readiness: 'api-key' as const,
          label: `Use your ${credentialName}`,
          detail: `Verify the ${credentialName} from your own account before the server is added.`,
        };
      }
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
            'This endpoint requires credentials, but Catalog has no reviewed prescription for how to send them.',
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
    !blockedReason && !policyRefusal && acknowledged && !connecting && (!needsApiKey || bearerToken)
  );
  const connectDisabledReason = connecting
    ? 'Connection in progress.'
    : !acknowledged
      ? 'Review the access disclosure and acknowledge it to continue.'
      : needsApiKey && !bearerToken
        ? `Enter your ${title} bearer access token to continue.`
        : undefined;

  return (
    <CatalogDrawer
      aria-labelledby={titleId}
      open={open}
      onClose={onClose}
      afterOpenChange={onAfterOpenChange}
      title={
        entry ? (
          <Space id={titleId} align="center" size={token.marginSM}>
            <CatalogEntryAvatar iconUrl={entry.icon_url} title={title} />
            <Flex vertical style={{ minWidth: 0 }}>
              <Text strong ellipsis>
                {title}
              </Text>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }} ellipsis>
                {entry.name}
              </Text>
            </Flex>
          </Space>
        ) : (
          <span id={titleId}>Catalog</span>
        )
      }
    >
      {entry ? (
        <>
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
            <Flex
              vertical
              align="center"
              gap={token.marginSM}
              style={{
                padding: `${token.paddingLG}px ${token.padding}px`,
                borderRadius: token.borderRadiusLG,
                background: token.colorFillQuaternary,
                textAlign: 'center',
              }}
            >
              <CheckCircleFilled
                aria-hidden
                style={{ color: token.colorSuccess, fontSize: token.fontSizeHeading2 }}
              />
              <div>
                <Title level={4} style={{ margin: 0 }}>
                  Added to My Servers
                </Title>
                <Paragraph type="secondary" style={{ margin: `${token.marginXXS}px 0 0` }}>
                  {success.authentication === 'ready'
                    ? `${title} is ready. Start a session now or keep browsing the MCP Catalog.`
                    : success.authentication === 'action_required'
                      ? `${title} was added. Continue sign-in now, or start a session and finish connecting later.`
                      : success.authentication === 'pending'
                        ? `${title} was added. Finish sign-in in the provider window while you choose what to do next.`
                        : success.authentication === 'failed'
                          ? `${title} was added, but sign-in did not finish. You can retry from My Servers.`
                          : `${title} was added. Agor could not verify the final sign-in result; check My Servers when ready.`}
                </Paragraph>
              </div>

              {success.authentication === 'action_required' && (
                <Button
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
                  Continue sign-in
                </Button>
              )}

              {success.reusedExistingServer && (
                <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  Your existing connection was reused; no duplicate server was added.
                </Text>
              )}

              {showSessionSetup ? (
                <Flex vertical gap={token.marginSM} style={{ width: '100%', textAlign: 'start' }}>
                  <Form layout="vertical" component="div">
                    <Form.Item label="Teammate" style={{ marginBottom: token.marginSM }}>
                      <Select<BranchID>
                        aria-label="Teammate"
                        showSearch
                        optionFilterProp="label"
                        loading={teammatesLoading}
                        value={teammateId}
                        onChange={setTeammateId}
                        options={teammateOptions}
                        placeholder={teammatesLoading ? 'Loading teammates…' : 'Select a teammate'}
                        notFoundContent={
                          teammatesLoading ? 'Loading teammates…' : 'No eligible teammates'
                        }
                      />
                    </Form.Item>
                    <Form.Item label="Agent tool" style={{ marginBottom: 0 }}>
                      <Select<AgenticToolName>
                        aria-label="Agent tool"
                        value={agenticTool}
                        onChange={setAgenticTool}
                        options={AGENT_OPTIONS}
                      />
                    </Form.Item>
                  </Form>
                  {teammatesError && <Alert type="error" showIcon title={teammatesError} />}
                  {startSessionError && <Alert type="error" showIcon title={startSessionError} />}
                  {!teammatesLoading && !teammatesError && teammates.length === 0 && (
                    <Text type="secondary">No active teammate is available for a new session.</Text>
                  )}
                  <Flex gap={token.marginXS} wrap justify="center">
                    <Button onClick={() => setShowSessionSetup(false)}>Back</Button>
                    <Button
                      type="primary"
                      icon={<ThunderboltOutlined aria-hidden />}
                      loading={startingSession}
                      disabled={!teammateId || teammatesLoading || Boolean(teammatesError)}
                      onClick={() =>
                        teammateId &&
                        onStartSession?.({ teammateBranchId: teammateId, agenticTool })
                      }
                    >
                      Start session
                    </Button>
                  </Flex>
                </Flex>
              ) : (
                <Flex gap={token.marginXS} wrap justify="center">
                  <Button type="text" onClick={onKeepBrowsing}>
                    Keep browsing
                  </Button>
                  <Button
                    ref={successActionRef}
                    type="primary"
                    onClick={() => {
                      onBeginSessionSetup?.();
                      setShowSessionSetup(true);
                    }}
                  >
                    Start new session
                  </Button>
                </Flex>
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

          <Flex vertical gap={token.marginXS}>
            <CatalogDetailSection
              key={`${entryId}:access`}
              defaultOpen
              label={
                <Space size={token.marginXS}>
                  <SafetyCertificateOutlined aria-hidden />
                  <Text strong>What this can access</Text>
                </Space>
              }
            >
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
            </CatalogDetailSection>
            <CatalogDetailSection
              key={`${entryId}:technical`}
              label={<Text strong>Technical details</Text>}
            >
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
                    children: catalogAuthenticationDetail(entry.auth_type, credentialRequirement),
                  },
                  {
                    key: 'tools',
                    label: 'Tools',
                    children: 'Discovered from the server after connection',
                  },
                ]}
              />
            </CatalogDetailSection>
          </Flex>

          {success ? null : blockedReason ? (
            <Alert type="info" showIcon title={blockedReason} />
          ) : (
            <Flex vertical gap={token.marginXS}>
              {needsApiKey && (
                <Form layout="vertical" size="middle" component="div">
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
                </Form>
              )}

              {connectError && <Alert type="error" showIcon title={connectError} />}
              {policyRefusal && <Alert type="info" showIcon title={policyRefusal} />}

              <Button
                type="primary"
                block
                icon={<ThunderboltOutlined aria-hidden />}
                aria-label="Connect"
                loading={connecting}
                disabled={!canConnect}
                onClick={() => {
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
                    acknowledgedDisclosure: disclosure,
                    // Only for an entry that asks. Sending a key to an endpoint
                    // that never wanted one is refused by the daemon, and the
                    // field it would have come from is not rendered anyway.
                    ...(needsApiKey ? { bearerToken } : {}),
                    ...(oauthPopup ? { oauthPopup } : {}),
                  });
                }}
              >
                Connect
              </Button>
              <Text
                type="secondary"
                role="status"
                aria-live="polite"
                style={{ fontSize: token.fontSizeSM }}
              >
                {connectDisabledReason ??
                  (runtimeStatus?.readiness === 'sign-in'
                    ? `Adds ${title} to My Servers and opens its sign-in popup.`
                    : runtimeStatus?.readiness === 'unchecked'
                      ? `Checks ${title}'s live authentication requirement before adding it.`
                      : `Adds ${title} to My Servers. No session is created yet.`)}
              </Text>
            </Flex>
          )}
        </>
      ) : (
        emptyContent
      )}
    </CatalogDrawer>
  );
};

/**
 * Consent and bearer credentials are caller-entered authority. A keyed state
 * owner destroys both during the A -> B render,
 * including the same-role/same-entry case that entry-keying alone cannot see.
 * Connection/auth-generation churn for one identity deliberately keeps them.
 */
export const CatalogDetailDrawer: React.FC<CatalogDetailDrawerProps> = (props) => (
  <CatalogDetailDrawerForIdentity
    key={props.identityKey ?? '__no-authenticated-user__'}
    {...props}
  />
);
