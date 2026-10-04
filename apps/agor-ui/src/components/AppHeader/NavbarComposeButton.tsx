import type { AgenticToolName, AgorClient, Branch, User } from '@agor-live/client';
import { DEFAULT_AGENTIC_TOOL_NAME } from '@agor-live/client';
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
import { useCallback, useEffect, useState } from 'react';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectUserById } from '../../store/selectors';
import { resolveSessionMcpServerIds } from '../../utils/resolveQuickStartMcpServerIds';
import { DEFAULT_TEAMMATE_EMOJI, teammateEmoji, teammateLabel } from '../../utils/teammateLabels';
import { AgenticConfigChipRow } from '../AgenticConfigChipRow';
import {
  buildNewSessionConfig,
  getNewSessionDefaultValues,
  getNewSessionToolSwitchValues,
} from '../AgenticToolConfigurationPicker/newSessionConfig';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { ComposeSendButtons, usePrimaryAssistantSend } from '../PrimaryAssistantCompose';
import { SessionAttachmentTray } from '../SessionPanel/SessionAttachmentTray';
import { SessionComposerDropZone } from '../SessionPanel/SessionComposerDropZone';
import { useComposerAttachments } from '../SessionPanel/useComposerAttachments';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';

const HINT_DISMISSED_KEY = 'agor:compose-hint-dismissed';

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

/**
 * Global compose affordance: ask your primary assistant from anywhere. Resolves
 * the caller's primary teammate branch, mounts an agent picker + config chips +
 * prompt, and either navigates to the new session ("Send & open") or leaves the
 * user in place ("Send in background"). A null primary shows the Settings picker
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

  const mcpServerById = useAgorStore(selectMcpServerById);
  const userById = useAgorStore(selectUserById);
  const agenticToolSettings = useAgorStore((state) => state.agenticToolSettingsByName);

  const [open, setOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string>(DEFAULT_AGENTIC_TOOL_NAME);
  const [prompt, setPrompt] = useState('');
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

  const hasContent = prompt.trim().length > 0 || attachments.length > 0;

  // One lightweight tinted-box treatment, shared by the tip and the no-primary banner.
  const bannerBox: React.CSSProperties = {
    padding: `${token.paddingXS}px ${token.paddingSM}px`,
    background: token.colorFillQuaternary,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadius,
  };

  // Resolve eagerly once the client exists (so the collapsed trigger shows the
  // teammate's emoji before first open) and re-resolve on open to catch changes
  // made elsewhere. The preference is optional; null asks for a target only
  // when the caller actually uses quick compose.
  const {
    primaryBranch,
    setPrimaryBranch,
    resolving,
    resolveFailed,
    pendingSend,
    clearPendingSend,
    submitting,
    send,
    pick,
  } = usePrimaryAssistantSend({
    client,
    currentUser,
    authenticationGeneration,
    isAuthenticationGenerationCurrent,
    currentBoardId,
    onCreateSession,
    refreshKey: open,
    buildConfig: (branch: Branch): NewSessionConfig =>
      buildNewSessionConfig({
        user: currentUser,
        tool: selectedAgent as AgenticToolName,
        branch,
        values: form.getFieldsValue(true),
        initialPrompt: prompt,
        attachmentFiles: attachments.map((attachment) => attachment.file),
      }),
    // Same conditions as the buttons' disabled state; also re-checked when picking a primary resumes a held send.
    canSend: () => !disabled && configValidity.valid && hasContent,
    validate: () =>
      form.validateFields().then(
        () => true,
        () => false
      ),
    onSent: () => closeAndReset(),
  });

  // Seed the chip-row form from the user's default on open. Only keyed on `open`
  // so a live user refresh can't wipe edits made while the popover is up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    const primaryTool = resolveAvailableUserAgenticTool(
      currentUser,
      agenticToolSettings,
      AVAILABLE_AGENTS
    );
    setSelectedAgent(primaryTool);
    form.resetFields();
    form.setFieldsValue(getNewSessionDefaultValues(currentUser, primaryTool));
  }, [open, form]);

  // Re-seed config defaults when the picked tool changes (same helper as NewSessionModal).
  useEffect(() => {
    // Ant Design does not connect the form instance until the lazy popover
    // content mounts. Calling form methods while the composer is collapsed
    // produces an unconnected-useForm warning and has no useful effect: the
    // open transition below initializes every field authoritatively.
    if (!open) return;
    form.setFieldsValue(
      getNewSessionToolSwitchValues(currentUser, selectedAgent as AgenticToolName)
    );
  }, [open, selectedAgent, form, currentUser]);

  const closeAndReset = () => {
    setOpen(false);
    setPrompt('');
    clearPendingSend();
    setPrimaryBranch(null);
    clearAttachments();
  };

  const handleConfigValidity = useCallback((valid: boolean, reason?: string) => {
    setConfigValidity((previous) =>
      previous.valid === valid && previous.reason === reason ? previous : { valid, reason }
    );
  }, []);

  const sendDisabled =
    disabled ||
    resolving ||
    resolveFailed ||
    !configValidity.valid ||
    submitting !== null ||
    !hasContent;

  const triggerEmoji = (primaryBranch && teammateEmoji(primaryBranch)) || DEFAULT_TEAMMATE_EMOJI;

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
            {teammateLabel(primaryBranch)}, your primary assistant
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
              <PrimaryTeammatePicker
                key={`${currentUser?.user_id ?? 'anonymous'}:${authenticationGeneration}`}
                client={client}
                currentUserId={currentUser?.user_id}
                authenticationGeneration={authenticationGeneration}
                compact
                disabled={disabled}
                onPicked={pick}
              />
            </div>
          )}

          <AgenticConfigChipRow
            tool={selectedAgent as AgenticToolName}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            client={client}
            branchId={primaryBranch?.branch_id}
            inheritedMcpServerIds={resolveSessionMcpServerIds(
              currentUser?.default_mcp_server_ids,
              primaryBranch
            )}
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
            <ComposeSendButtons
              branch={primaryBranch}
              submitting={submitting}
              disabled={sendDisabled}
              onSend={send}
            />
          </Flex>
        </Form>
      )}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (disabled) return;
        setOpen(nextOpen);
        // A held send belongs to this opening; a later pick must not send a stale draft.
        if (!nextOpen) clearPendingSend();
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
