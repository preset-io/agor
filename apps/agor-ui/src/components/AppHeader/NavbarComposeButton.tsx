import type {
  AgenticToolName,
  AgorClient,
  Branch,
  EffortLevel,
  PermissionMode,
  User,
} from '@agor-live/client';
import { getDefaultPermissionMode, getTeammateConfig } from '@agor-live/client';
import { EditOutlined } from '@ant-design/icons';
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
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectMcpServerById, selectUserById } from '../../store/selectors';
import { AgenticConfigChipRow } from '../AgenticConfigChipRow';
import { buildConfigFromFormValues, getFormValuesFromConfig } from '../AgenticToolConfigForm';
import { INLINE_AGENTIC_CONFIGURATION } from '../AgenticToolConfigurationPicker';
import {
  getUserAgenticToolDefault,
  getUserDefaultConfigurationSource,
} from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import type { NewSessionConfig } from '../NewSessionModal';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';

// Compact composer defaults to Claude Code; the chip row still lets the model be tuned.
const COMPOSE_TOOL: AgenticToolName = 'claude-code';

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

/**
 * Global compose affordance: ask your primary assistant from anywhere. Resolves
 * the caller's primary teammate branch, mounts a compact model picker + prompt,
 * and either navigates to the new session ("Send & Open") or leaves the user in
 * place ("Send in Background"). A null primary shows the Settings picker inline
 * and resumes the send once one is chosen, preserving the typed prompt.
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
  const [prompt, setPrompt] = useState('');
  const [pendingSend, setPendingSend] = useState<SendMode | null>(null);
  const [submitting, setSubmitting] = useState<SendMode | null>(null);
  const [inPlaceResult, setInPlaceResult] = useState<{ sessionId: string; branch: Branch } | null>(
    null
  );

  const onBoardSurface = !!currentBoardId && !isKnowledgePath(location.pathname);

  // Resolve the primary teammate each time the popover opens — access can change
  // between opens (branch archived, unshared), and null is the "needs picking" signal.
  useEffect(() => {
    if (!open || !client) return;
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

  // Seed the chip-row form from the user's Claude Code default on open. Only keyed
  // on `open` so a live user refresh can't wipe edits made while the popover is up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    const agentDefaults = getUserAgenticToolDefault(currentUser, COMPOSE_TOOL).configuration;
    form.resetFields();
    form.setFieldsValue({
      agenticToolPresetId: getUserDefaultConfigurationSource(currentUser, COMPOSE_TOOL),
      ...getFormValuesFromConfig(COMPOSE_TOOL, agentDefaults),
      mcpServerIds: currentUser?.default_mcp_server_ids,
    });
  }, [open, form]);

  const closeAndReset = () => {
    setOpen(false);
    setPrompt('');
    setPendingSend(null);
    setPrimaryBranch(null);
  };

  const buildConfig = (branch: Branch): NewSessionConfig => {
    const values = form.getFieldsValue(true);
    const agentDefaults = getUserAgenticToolDefault(currentUser, COMPOSE_TOOL).configuration;
    const permissionMode: PermissionMode =
      (values.permissionMode as PermissionMode | undefined) ??
      agentDefaults?.permissionMode ??
      getDefaultPermissionMode(COMPOSE_TOOL);
    const isInline = values.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION;
    const inlineConfig = isInline
      ? buildConfigFromFormValues(COMPOSE_TOOL, {
          modelConfig: values.modelConfig,
          effort: values.effort,
          permissionMode: values.permissionMode,
        })
      : undefined;
    const fallbackMcpServerIds =
      branch.mcp_server_ids && branch.mcp_server_ids.length > 0
        ? branch.mcp_server_ids
        : currentUser?.default_mcp_server_ids;

    return {
      branch_id: branch.branch_id,
      agent: COMPOSE_TOOL,
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
    };
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

  const sendDisabled = resolving || submitting !== null || !prompt.trim();

  const wayfinding = (() => {
    if (!primaryBranch) return null;
    const name = teammateName(primaryBranch);
    const board = primaryBranch.board_id ? boardById.get(primaryBranch.board_id) : undefined;
    if (!onBoardSurface) {
      return `Opens a panel here — session starts with ${name}${board ? ` on ${board.name}` : ''}.`;
    }
    if (primaryBranch.board_id && primaryBranch.board_id !== currentBoardId) {
      return `→ Opens on ${name}${board ? ` · ${board.name}` : ''}`;
    }
    return `Creates a session with ${name} here.`;
  })();

  const content = (
    <div style={{ width: 380 }}>
      {resolving ? (
        <Flex justify="center" style={{ padding: token.paddingLG }}>
          <Spin />
        </Flex>
      ) : (
        <Form form={form} layout="vertical" requiredMark={false}>
          {!primaryBranch && (
            <div style={{ marginBottom: token.marginSM }}>
              <PrimaryTeammatePicker client={client} compact onPicked={handlePicked} />
            </div>
          )}

          <AgenticConfigChipRow
            tool={COMPOSE_TOOL}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            client={client}
            showEffort
          />

          <Form.Item style={{ marginBottom: token.marginXS }}>
            <AutocompleteTextarea
              value={prompt}
              onChange={setPrompt}
              placeholder="Ask your primary assistant…"
              autoSize={{ minRows: 2, maxRows: 6 }}
              client={client}
              sessionId={null}
              userById={userById}
              enableKnowledgeMentions
              kbLinkTarget="absolute-route"
            />
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
            <Button
              onClick={() => runSend('background')}
              loading={submitting === 'background'}
              disabled={sendDisabled}
            >
              Send in Background
            </Button>
            <Button
              type="primary"
              onClick={() => runSend('open')}
              loading={submitting === 'open'}
              disabled={sendDisabled}
            >
              Send &amp; Open
            </Button>
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
        <Button
          type="text"
          icon={<EditOutlined style={{ fontSize: token.fontSizeLG }} />}
          aria-label="Compose — ask your primary assistant"
          title="Ask your primary assistant"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        />
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
