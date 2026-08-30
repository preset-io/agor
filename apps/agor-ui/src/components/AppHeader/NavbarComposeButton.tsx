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
  DEFAULT_AGENTIC_TOOL_NAME,
  getDefaultPermissionMode,
  getTeammateConfig,
  mapToCodexPermissionConfig,
} from '@agor-live/client';
import { BulbOutlined, CloseOutlined, EditOutlined, RobotOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Flex,
  Form,
  Popover,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useIdentityGuardedAsync } from '../../hooks/useIdentityGuardedAsync';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectUserById } from '../../store/selectors';
import { AgenticConfigChipRow } from '../AgenticConfigChipRow';
import { buildConfigFromFormValues, getFormValuesFromConfig } from '../AgenticToolConfigForm';
import { INLINE_AGENTIC_CONFIGURATION } from '../AgenticToolConfigurationPicker';
import {
  getUserAgenticToolDefault,
  getUserDefaultConfigurationSource,
} from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { SessionAttachmentTray } from '../SessionPanel/SessionAttachmentTray';
import { SessionComposerDropZone } from '../SessionPanel/SessionComposerDropZone';
import { useComposerAttachments } from '../SessionPanel/useComposerAttachments';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';

const HINT_DISMISSED_KEY = 'agor:compose-hint-dismissed';

type SendMode = 'open' | 'background';

export interface NavbarComposeButtonProps {
  client: AgorClient | null;
  currentUser?: User | null;
  authenticationGeneration?: number;
  isAuthenticationGenerationCurrent?: (generation: number) => boolean;
  /** The board currently in view, or '' on a non-board surface (home/knowledge). */
  currentBoardId?: string;
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
  disabled?: boolean;
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
  authenticationGeneration = 0,
  isAuthenticationGenerationCurrent,
  currentBoardId,
  onCreateSession,
  disabled = false,
}) => {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const navigation = useAppNavigation();
  const sessionCreationGuard = useIdentityGuardedAsync([
    currentUser?.user_id,
    authenticationGeneration,
  ]);

  const mcpServerById = useAgorStore(selectMcpServerById);
  const userById = useAgorStore(selectUserById);
  const agenticToolSettings = useAgorStore((state) => state.agenticToolSettingsByName);

  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveFailed, setResolveFailed] = useState(false);
  const [primaryBranch, setPrimaryBranch] = useState<Branch | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>(DEFAULT_AGENTIC_TOOL_NAME);
  const [prompt, setPrompt] = useState('');
  const [pendingSend, setPendingSend] = useState<SendMode | null>(null);
  const [submitting, setSubmitting] = useState<SendMode | null>(null);
  const [configValidity, setConfigValidity] = useState<{ valid: boolean; reason?: string }>({
    valid: true,
  });
  const [hintDismissed, setHintDismissed] = useLocalStorage<boolean>(HINT_DISMISSED_KEY, false);
  const { attachments, addAttachments, removeAttachment, clearAttachments } =
    useComposerAttachments({
      sessionId: null,
      scopeKey: `navbar:${currentUser?.user_id ?? 'anonymous'}`,
      showError: (msg) => message.error(msg),
    });
  const mcpEditedRef = useRef(false);
  const mcpInitializedBranchIdRef = useRef<string | null>(null);

  // One lightweight tinted-box treatment, shared by the tip and the no-primary banner.
  const bannerBox: React.CSSProperties = {
    padding: `${token.paddingXS}px ${token.paddingSM}px`,
    background: token.colorFillQuaternary,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadius,
  };

  const initializeMcpForBranch = useCallback(
    (branch: Branch) => {
      if (mcpInitializedBranchIdRef.current === branch.branch_id) return;
      if (!mcpEditedRef.current) {
        const branchMcpIds = branch.mcp_server_ids;
        form.setFieldValue(
          'mcpServerIds',
          branchMcpIds && branchMcpIds.length > 0
            ? branchMcpIds
            : currentUser?.default_mcp_server_ids
        );
      }
      mcpInitializedBranchIdRef.current = branch.branch_id;
    },
    [currentUser?.default_mcp_server_ids, form]
  );

  // Resolve eagerly once the client exists (so the collapsed trigger shows the
  // teammate's emoji before first open) and re-resolve on open to catch changes
  // made elsewhere. The preference is optional; null asks for a target only
  // when the caller actually uses quick compose.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reopen and caller changes deliberately invalidate the caller-scoped preference
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setResolving(true);
    setResolveFailed(false);
    client
      .service('users')
      .getPrimaryTeammate()
      .then((branch) => {
        if (!cancelled) {
          setPrimaryBranch(branch);
          setResolveFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setResolveFailed(true);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client, currentUser?.user_id, authenticationGeneration]);

  // Seed the chip-row form from the user's default on open. Only keyed on `open`
  // so a live user refresh can't wipe edits made while the popover is up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    mcpEditedRef.current = false;
    mcpInitializedBranchIdRef.current = null;
    const primaryTool = resolveAvailableUserAgenticTool(
      currentUser,
      agenticToolSettings,
      AVAILABLE_AGENTS
    );
    setSelectedAgent(primaryTool);
    const agentDefaults = getUserAgenticToolDefault(currentUser, primaryTool).configuration;
    form.resetFields();
    form.setFieldsValue({
      agenticToolPresetId: getUserDefaultConfigurationSource(currentUser, primaryTool),
      ...getFormValuesFromConfig(primaryTool, agentDefaults),
      mcpServerIds: currentUser?.default_mcp_server_ids,
    });
  }, [open, form]);

  // Initialize branch inheritance once. Later branch resolution must not wipe
  // a value the caller already edited while choosing an assistant.
  useEffect(() => {
    if (!open || !primaryBranch) return;
    initializeMcpForBranch(primaryBranch);
  }, [open, primaryBranch, initializeMcpForBranch]);

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

  const handleConfigValidity = useCallback((valid: boolean, reason?: string) => {
    setConfigValidity((previous) =>
      previous.valid === valid && previous.reason === reason ? previous : { valid, reason }
    );
  }, []);

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
    const operationAuthenticationGeneration = authenticationGeneration;
    setSubmitting(mode);
    try {
      const outcome = await sessionCreationGuard.run(() =>
        onCreateSession(buildConfig(branch), branch.board_id ?? currentBoardId ?? '')
      );
      if (!outcome) return; // onCreateSession already surfaced the failure
      if (
        isAuthenticationGenerationCurrent &&
        !isAuthenticationGenerationCurrent(operationAuthenticationGeneration)
      ) {
        return;
      }
      const { sessionId } = outcome;
      finishSuccessfulSend(mode, branch, sessionId);
    } finally {
      setSubmitting(null);
    }
  };

  const finishSuccessfulSend = (mode: SendMode, branch: Branch, sessionId: string) => {
    if (mode === 'background') {
      message.success(`Sent to ${teammateName(branch)} in the background`);
      closeAndReset();
      return;
    }

    closeAndReset();
    navigation.goToSession(sessionId);
  };

  const runSend = async (mode: SendMode, branch = primaryBranch) => {
    if (disabled || resolveFailed || !configValidity.valid) return;
    if (!branch) {
      // Arm synchronously so a fast picker selection cannot outrun validation.
      // The picked branch path validates immediately before creating.
      setPendingSend(mode);
      return;
    }
    try {
      await form.validateFields();
    } catch {
      return;
    }
    await doSend(mode, branch);
  };

  const handlePicked = (branch: Branch) => {
    initializeMcpForBranch(branch);
    setPrimaryBranch(branch);
    if (pendingSend) {
      const mode = pendingSend;
      setPendingSend(null);
      void runSend(mode, branch);
    }
  };

  const sendDisabled =
    disabled ||
    resolving ||
    resolveFailed ||
    !configValidity.valid ||
    submitting !== null ||
    (!prompt.trim() && attachments.length === 0);

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
      ) : resolveFailed ? (
        <Alert
          type="error"
          showIcon
          message="Couldn't load your primary assistant"
          description="Check the connection and reopen this composer to retry."
        />
      ) : (
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          onValuesChange={(changedValues) => {
            if (Object.hasOwn(changedValues, 'mcpServerIds')) mcpEditedRef.current = true;
          }}
        >
          {!primaryBranch && (
            <div style={{ marginBottom: token.marginSM }}>
              <div style={{ ...bannerBox, marginBottom: token.marginSM }}>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  You don't have a primary assistant yet. Your primary assistant is your default
                  teammate for personal, ambient work — pick one below to continue. You can change
                  it anytime in Settings.
                </Typography.Text>
              </div>
              <PrimaryTeammatePicker
                key={`${currentUser?.user_id ?? 'anonymous'}:${authenticationGeneration}`}
                client={client}
                currentUserId={currentUser?.user_id}
                authenticationGeneration={authenticationGeneration}
                compact
                disabled={disabled}
                onPicked={handlePicked}
              />
            </div>
          )}

          <AgenticConfigChipRow
            tool={selectedAgent as AgenticToolName}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            client={client}
            branchId={primaryBranch?.branch_id}
            validateModelSelection
            showEffort
            collapsibleChips
            onConfigValidityChange={handleConfigValidity}
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
            <SessionComposerDropZone
              disabled={disabled || submitting !== null}
              onFilesDrop={addAttachments}
            >
              <SessionAttachmentTray
                attachments={attachments}
                disabled={disabled || submitting !== null}
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
                filesDropDisabled={disabled || submitting !== null}
                showFilesDropOverlay={false}
              />
            </SessionComposerDropZone>
          </Form.Item>

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
                onClick={() => void runSend('background')}
                loading={submitting === 'background'}
                disabled={sendDisabled}
              >
                Send in Background
              </Button>
            </Tooltip>
            <Tooltip title={openTooltip}>
              <Button
                type="primary"
                onClick={() => void runSend('open')}
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
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!disabled) setOpen(nextOpen);
      }}
      trigger="click"
      placement="bottomRight"
      destroyTooltipOnHide
      content={content}
    >
      <Tooltip title="Start quick session">
        <Button
          type="default"
          aria-label="Compose — ask your primary assistant"
          disabled={disabled}
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
  );
};
