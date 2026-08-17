import type {
  AgenticToolName,
  AgorClient,
  Branch,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  PermissionMode,
  User,
} from '@agor-live/client';
import {
  getDefaultPermissionMode,
  getTeammateConfig,
  mapToCodexPermissionConfig,
} from '@agor-live/client';
import { BulbOutlined, CloseOutlined, EditOutlined, RobotOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Drawer,
  Flex,
  Form,
  Popover,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectMcpServerById, selectUserById } from '../../store/selectors';
import { AgenticConfigChipRow } from '../AgenticConfigChipRow';
import { buildConfigFromFormValues, getFormValuesFromConfig } from '../AgenticToolConfigForm';
import { INLINE_AGENTIC_CONFIGURATION } from '../AgenticToolConfigurationPicker';
import {
  getUserAgenticToolDefault,
  getUserDefaultConfigurationSource,
} from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import type { NewSessionConfig } from '../NewSessionModal';
import { SessionAttachmentTray } from '../SessionPanel/SessionAttachmentTray';
import { SessionComposerDropZone } from '../SessionPanel/SessionComposerDropZone';
import { useComposerAttachments } from '../SessionPanel/useComposerAttachments';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';

const DEFAULT_TOOL: AgenticToolName = 'claude-code';
const HINT_DISMISSED_KEY = 'agor:compose-hint-dismissed';

type SendMode = 'open' | 'background';

export interface NavbarComposeButtonProps {
  client: AgorClient | null;
  currentUser?: User | null;
  /** The board currently in view, or '' on a non-board surface (home/knowledge). */
  currentBoardId?: string;
  onCreateSession?: (config: NewSessionConfig, boardId: string) => Promise<string | null>;
}

/** Knowledge Base renders no board even when a board id lingers in app state. */
function isKnowledgePath(pathname: string): boolean {
  return ['/knowledge', '/kb'].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function teammateName(branch: Branch): string {
  return getTeammateConfig(branch)?.displayName ?? branch.name;
}

function teammateEmoji(branch: Branch): string | undefined {
  return getTeammateConfig(branch)?.emoji;
}

/**
 * Global compose affordance: ask your primary assistant from anywhere. Resolves
 * the caller's primary teammate branch, mounts an agent picker + config chips +
 * prompt, and either navigates to the new session ("Send & Open") or leaves the
 * user in place ("Send in Background"). A null primary shows the Settings picker
 * inline and resumes the send once one is chosen, preserving the typed prompt.
 */
export const NavbarComposeButton: React.FC<NavbarComposeButtonProps> = ({
  client,
  currentUser,
  currentBoardId,
  onCreateSession,
}) => {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const navigation = useAppNavigation();
  const location = useLocation();

  const mcpServerById = useAgorStore(selectMcpServerById);
  const userById = useAgorStore(selectUserById);
  const boardById = useAgorStore(selectBoardById);

  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [primaryBranch, setPrimaryBranch] = useState<Branch | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>(DEFAULT_TOOL);
  const [prompt, setPrompt] = useState('');
  const [pendingSend, setPendingSend] = useState<SendMode | null>(null);
  const [submitting, setSubmitting] = useState<SendMode | null>(null);
  const [inPlaceResult, setInPlaceResult] = useState<{ sessionId: string; branch: Branch } | null>(
    null
  );
  const [hintDismissed, setHintDismissed] = useLocalStorage<boolean>(HINT_DISMISSED_KEY, false);
  const { attachments, addAttachments, removeAttachment, clearAttachments } =
    useComposerAttachments({ sessionId: null, showError: (msg) => message.error(msg) });

  const onBoardSurface = !!currentBoardId && !isKnowledgePath(location.pathname);

  // One lightweight tinted-box treatment, shared by the tip and the no-primary banner.
  const bannerBox: React.CSSProperties = {
    padding: `${token.paddingXS}px ${token.paddingSM}px`,
    background: token.colorFillQuaternary,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadius,
  };

  // Resolve eagerly once the client exists (so the collapsed trigger shows the
  // teammate's emoji before first open) and re-resolve on open to catch changes
  // made elsewhere. Null is the "needs picking" signal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` re-resolves on reopen
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setResolving(true);
    client
      .service('users')
      .getPrimaryTeammate()
      .then((branch) => {
        if (!cancelled) setPrimaryBranch(branch);
      })
      .catch(() => {
        if (!cancelled) setPrimaryBranch(null);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  // Seed the chip-row form from the user's default on open. Only keyed on `open`
  // so a live user refresh can't wipe edits made while the popover is up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    setSelectedAgent(DEFAULT_TOOL);
    const agentDefaults = getUserAgenticToolDefault(currentUser, DEFAULT_TOOL).configuration;
    form.resetFields();
    form.setFieldsValue({
      agenticToolPresetId: getUserDefaultConfigurationSource(currentUser, DEFAULT_TOOL),
      ...getFormValuesFromConfig(DEFAULT_TOOL, agentDefaults),
      mcpServerIds: currentUser?.default_mcp_server_ids,
    });
  }, [open, form]);

  // Re-seed config defaults when the picked tool changes (mirrors NewSessionModal).
  useEffect(() => {
    const tool = selectedAgent as AgenticToolName;
    const agentDefaults = getUserAgenticToolDefault(currentUser, tool).configuration;
    form.setFieldsValue({
      ...getFormValuesFromConfig(tool, agentDefaults),
      agenticToolPresetId: getUserDefaultConfigurationSource(currentUser, tool),
      ...(tool !== 'codex' && {
        codexSandboxMode: undefined,
        codexApprovalPolicy: undefined,
        codexNetworkAccess: undefined,
      }),
    });
  }, [selectedAgent, form, currentUser]);

  const closeAndReset = () => {
    setOpen(false);
    setPrompt('');
    setPendingSend(null);
    setPrimaryBranch(null);
    clearAttachments();
  };

  const buildConfig = (branch: Branch): NewSessionConfig => {
    const tool = selectedAgent as AgenticToolName;
    const values = form.getFieldsValue(true);
    const agentDefaults = getUserAgenticToolDefault(currentUser, tool).configuration;
    const permissionMode: PermissionMode =
      (values.permissionMode as PermissionMode | undefined) ??
      agentDefaults?.permissionMode ??
      getDefaultPermissionMode(tool);
    const isInline = values.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION;
    const inlineConfig = isInline
      ? buildConfigFromFormValues(tool, {
          modelConfig: values.modelConfig,
          effort: values.effort,
          permissionMode: values.permissionMode,
        })
      : undefined;
    const fallbackMcpServerIds =
      branch.mcp_server_ids && branch.mcp_server_ids.length > 0
        ? branch.mcp_server_ids
        : currentUser?.default_mcp_server_ids;

    const config: NewSessionConfig = {
      branch_id: branch.branch_id,
      agent: tool,
      agenticToolPresetId: isInline ? undefined : values.agenticToolPresetId,
      initialPrompt: prompt,
      modelConfig: isInline
        ? inlineConfig?.modelConfig
        : (values.modelConfig ?? agentDefaults?.modelConfig),
      effort: isInline
        ? undefined
        : ((values.effort as EffortLevel | undefined) ?? agentDefaults?.modelConfig?.effort),
      mcpServerIds: values.mcpServerIds ?? fallbackMcpServerIds,
      permissionMode,
      attachmentFiles:
        attachments.length > 0 ? attachments.map((attachment) => attachment.file) : undefined,
    };

    if (tool === 'codex') {
      const codexDefaults = mapToCodexPermissionConfig(permissionMode);
      config.codexSandboxMode =
        (values.codexSandboxMode as CodexSandboxMode | undefined) ??
        agentDefaults?.codexSandboxMode ??
        codexDefaults.sandboxMode;
      config.codexApprovalPolicy =
        (values.codexApprovalPolicy as CodexApprovalPolicy | undefined) ??
        agentDefaults?.codexApprovalPolicy ??
        codexDefaults.approvalPolicy;
      config.codexNetworkAccess =
        values.codexNetworkAccess ??
        agentDefaults?.codexNetworkAccess ??
        codexDefaults.networkAccess;
    }

    return config;
  };

  const doSend = async (mode: SendMode, branch: Branch) => {
    if (!onCreateSession) return;
    setSubmitting(mode);
    try {
      const sessionId = await onCreateSession(
        buildConfig(branch),
        branch.board_id ?? currentBoardId ?? ''
      );
      if (!sessionId) return; // onCreateSession already surfaced the failure

      if (mode === 'background') {
        message.success(`Sent to ${teammateName(branch)} in the background`);
        closeAndReset();
        return;
      }

      if (onBoardSurface) {
        // Case 1 / same-board: full navigation to the new session.
        closeAndReset();
        navigation.goToSession(sessionId);
      } else {
        // Case 2: non-board surface — stay put, surface an in-place panel.
        setOpen(false);
        setPrompt('');
        setPendingSend(null);
        clearAttachments();
        setInPlaceResult({ sessionId, branch });
      }
    } finally {
      setSubmitting(null);
    }
  };

  const runSend = (mode: SendMode) => {
    if (!primaryBranch) {
      // Null primary: arm the send; the inline picker resumes it once chosen.
      setPendingSend(mode);
      return;
    }
    void doSend(mode, primaryBranch);
  };

  const handlePicked = (branch: Branch) => {
    setPrimaryBranch(branch);
    if (pendingSend) {
      const mode = pendingSend;
      setPendingSend(null);
      void doSend(mode, branch);
    }
  };

  const sendDisabled =
    resolving || submitting !== null || (!prompt.trim() && attachments.length === 0);

  const wayfinding = (() => {
    if (!primaryBranch) return null;
    const name = teammateName(primaryBranch);
    const board = primaryBranch.board_id ? boardById.get(primaryBranch.board_id) : undefined;
    if (onBoardSurface && primaryBranch.board_id && primaryBranch.board_id !== currentBoardId) {
      return `→ Opens on ${name}${board ? ` · ${board.name}` : ''}`;
    }
    return null;
  })();

  const triggerEmoji = (primaryBranch && teammateEmoji(primaryBranch)) || '🤖';
  const boardPhrase = primaryBranch
    ? `${teammateName(primaryBranch)}'s board`
    : "your primary assistant's board";
  const openTooltip = `Creates the session and takes you there now, on ${boardPhrase}.`;
  const backgroundTooltip = `Creates the session in the background, on ${boardPhrase} — check on it anytime.`;

  const content = (
    <div style={{ width: 450, maxWidth: '90vw' }}>
      <Typography.Text strong style={{ display: 'block', marginBottom: token.marginSM }}>
        {primaryBranch ? (
          <>
            Ask{' '}
            {teammateEmoji(primaryBranch) ? (
              `${teammateEmoji(primaryBranch)} `
            ) : (
              <RobotOutlined style={{ marginInlineEnd: token.marginXXS }} />
            )}
            {teammateName(primaryBranch)}, your primary assistant
          </>
        ) : (
          'Ask your primary assistant'
        )}
      </Typography.Text>

      {!hintDismissed && (
        <Flex
          align="flex-start"
          gap={token.marginXS}
          style={{ ...bannerBox, marginBottom: token.marginSM }}
        >
          <BulbOutlined style={{ color: token.colorTextTertiary, marginTop: 3 }} />
          <Typography.Text type="secondary" style={{ flex: 1, fontSize: token.fontSizeSM }}>
            Ask for anything — setup help, finding a feature, fixing something. Your assistant
            handles it for you.
          </Typography.Text>
          <Button
            type="text"
            size="small"
            aria-label="Dismiss tip"
            icon={<CloseOutlined style={{ fontSize: token.fontSizeSM }} />}
            onClick={() => setHintDismissed(true)}
          />
        </Flex>
      )}

      {resolving ? (
        <Flex justify="center" style={{ padding: token.paddingLG }}>
          <Spin />
        </Flex>
      ) : (
        <Form form={form} layout="vertical" requiredMark={false}>
          {!primaryBranch && (
            <div style={{ marginBottom: token.marginSM }}>
              <div style={{ ...bannerBox, marginBottom: token.marginSM }}>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  You don't have a primary assistant yet. Your primary assistant is your default
                  teammate for personal, ambient work — pick one below to continue. You can change
                  it anytime in Settings.
                </Typography.Text>
              </div>
              <PrimaryTeammatePicker client={client} compact onPicked={handlePicked} />
            </div>
          )}

          <AgenticConfigChipRow
            tool={selectedAgent as AgenticToolName}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            client={client}
            showEffort
            leadingField={
              <Form.Item label="Coding agent" style={{ marginBottom: token.marginSM }}>
                <AgentSelectionGrid
                  agents={AVAILABLE_AGENTS}
                  selectedAgentId={selectedAgent}
                  onSelect={setSelectedAgent}
                  variant="select"
                  showComparisonLink={false}
                  fallbackToFirstVisibleAgent
                />
              </Form.Item>
            }
          />

          <Form.Item style={{ marginBottom: token.marginXS }}>
            <SessionComposerDropZone disabled={submitting !== null} onFilesDrop={addAttachments}>
              <SessionAttachmentTray
                attachments={attachments}
                disabled={submitting !== null}
                onRemove={removeAttachment}
              />
              <AutocompleteTextarea
                value={prompt}
                onChange={setPrompt}
                placeholder={
                  'Ask your primary assistant… e.g. “connect Slack”, “find the API docs”, “fix this bug”'
                }
                autoSize={{ minRows: 2, maxRows: 6 }}
                client={client}
                sessionId={null}
                userById={userById}
                enableKnowledgeMentions
                kbLinkTarget="absolute-route"
                onFilesDrop={addAttachments}
                filesDropDisabled={submitting !== null}
                showFilesDropOverlay={false}
              />
            </SessionComposerDropZone>
          </Form.Item>

          {wayfinding && (
            <Typography.Text
              type="secondary"
              style={{ fontSize: token.fontSizeSM, display: 'block', marginBottom: token.marginXS }}
            >
              {wayfinding}
            </Typography.Text>
          )}
          {!primaryBranch && pendingSend && (
            <Typography.Text
              type="secondary"
              style={{ fontSize: token.fontSizeSM, display: 'block', marginBottom: token.marginXS }}
            >
              Pick a primary assistant above to send.
            </Typography.Text>
          )}

          <Flex justify="flex-end" gap={token.marginXS}>
            <Tooltip title={backgroundTooltip}>
              <Button
                onClick={() => runSend('background')}
                loading={submitting === 'background'}
                disabled={sendDisabled}
              >
                Send in Background
              </Button>
            </Tooltip>
            <Tooltip title={openTooltip}>
              <Button
                type="primary"
                onClick={() => runSend('open')}
                loading={submitting === 'open'}
                disabled={sendDisabled}
              >
                Send &amp; Open
              </Button>
            </Tooltip>
          </Flex>
        </Form>
      )}
    </div>
  );

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomRight"
        destroyTooltipOnHide
        content={content}
      >
        <Tooltip title="Start quick session">
          <Button
            type="default"
            aria-label="Compose — ask your primary assistant"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: token.marginXXS,
            }}
          >
            <span style={{ fontSize: token.fontSize, lineHeight: 1 }}>{triggerEmoji}</span>
            <EditOutlined style={{ fontSize: token.fontSizeLG }} />
          </Button>
        </Tooltip>
      </Popover>

      <Drawer
        open={!!inPlaceResult}
        onClose={() => setInPlaceResult(null)}
        title="Session started"
        placement="right"
        width={340}
      >
        {inPlaceResult && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Typography.Text>
              Your session with{' '}
              <Typography.Text strong>{teammateName(inPlaceResult.branch)}</Typography.Text> is
              running.
            </Typography.Text>
            <Tag>
              {(inPlaceResult.branch.board_id &&
                boardById.get(inPlaceResult.branch.board_id)?.name) ||
                'its board'}
            </Tag>
            <Button
              type="primary"
              onClick={() => {
                const sessionId = inPlaceResult.sessionId;
                setInPlaceResult(null);
                navigation.goToSession(sessionId);
              }}
            >
              Open on board
            </Button>
          </Space>
        )}
      </Drawer>
    </>
  );
};
