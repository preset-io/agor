// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Staged session panel for the demo-video "session" scene.
//
// Everything visible is a REAL product component — TaskBlock (→ MessageBlock /
// AgentChain) for the transcript, AutocompleteTextarea for the composer, and
// SessionFooter for the action bar — driven purely by the scene's virtual
// clock `t`. The full SessionPanel can't be staged directly because its
// transcript hydrates through the client-side reactive-session handle (which
// needs a live daemon), so this frames the same leaf components with
// timeline-derived Task/Message fixtures instead. No client, no wall clock:
// message objects are a pure function of the scene's `sessionPhase` flag and
// the `composer`/`response` text tracks.

import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  MCPServer,
  Message,
  PermissionMode,
  Session,
  SessionID,
  Task,
  User,
} from '@agor-live/client';
import { MessageRole, SessionStatus, TaskStatus } from '@agor-live/client';
import {
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Badge, Button, Divider, Space, Tooltip, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { AutocompleteTextarea } from '../../components/AutocompleteTextarea';
import { BranchHeaderPill } from '../../components/BranchHeaderPill';
import { CreatedByTag } from '../../components/metadata';
import { ChannelPill, IssuePill, PullRequestPill } from '../../components/Pill';
import { SessionFooter } from '../../components/SessionPanel/SessionFooter';
import { TaskBlock } from '../../components/TaskBlock';
import { ToolIcon } from '../../components/ToolIcon';
import { demoBranches, demoNow, demoRepo, demoUsers } from './fixtureData';
import { GATEWAY_PROMPT } from './scenes/gateway';
import { MULTIPLAYER_FOLLOWUP, MULTIPLAYER_PROMPT } from './scenes/multiplayer';
import { SESSION_PANEL_WIDTH, SESSION_PROMPT } from './scenes/session';
import type { SceneDefinition } from './timeline';

const USER_BY_ID = new Map<string, User>(demoUsers.map((user) => [user.user_id, user]));
const CURRENT_USER_ID = demoUsers[0].user_id;
const STAGE_BRANCH = demoBranches[0]; // landing-hero-polish
const STAGE_SESSION_ID = '019ee88d-demo-branch-0000-000000000101-session-9' as SessionID;
const STAGE_MODEL = 'claude-opus-4-6';

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_MCP_SERVERS: MCPServer[] = [];
const EMPTY_TASKS: Task[] = [];
const MCP_SERVER_BY_ID = new Map<string, MCPServer>();
const AUTHED_MCP_IDS = new Set<string>();
const NOOP = () => undefined;

const BASE_SESSION = {
  session_id: STAGE_SESSION_ID,
  agentic_tool: 'claude-code',
  status: SessionStatus.IDLE,
  created_at: demoNow,
  last_updated: demoNow,
  created_by: CURRENT_USER_ID,
  branch_id: STAGE_BRANCH.branch_id,
  title: 'Claude: dark mode for the settings page',
  description: 'dark mode for the settings page',
  model_config: { mode: 'alias', model: STAGE_MODEL },
  ready_for_prompt: true,
  archived: false,
  genealogy: { children: [] },
  tasks: [],
} as unknown as Session;

// ---------------------------------------------------------------------------
// Stage variants — the same staged panel tells three stories: the direct
// "session" scene (a human types a prompt into the composer), the "gateway"
// scene (an inbound Slack message pops into the transcript whole), and the
// "collab" scene (Ari prompts, then Jules queues a follow-up task while the
// agent is still running). All content differences live here; the render
// below is variant-agnostic.
// ---------------------------------------------------------------------------

export type StageVariant = 'coding' | 'gateway' | 'collab';

interface StageVariantConfig {
  headerTitle: string;
  /** Prompt of the live (animated) task. */
  prompt: string;
  /** Who authored the live prompt (gateway messages come from a teammate). */
  promptCreatedBy: string;
  priorPrompt: string;
  priorResponse: string;
  /** Tool-chain inputs for the live task's Read/Edit beats. */
  readInput: Record<string, unknown>;
  editInput: Record<string, unknown>;
  /** Slack channel pill shown in the pills row (gateway only). */
  channel?: { type: string; name: string };
  /** Follow-up prompt shown in the queued-tasks drawer when the scene's
   * `queuedVisible` uiFlag is on (collab only). */
  queuedPrompt?: string;
}

const STAGE_VARIANTS: Record<StageVariant, StageVariantConfig> = {
  coding: {
    headerTitle: 'Dark mode for the settings page',
    prompt: SESSION_PROMPT,
    promptCreatedBy: CURRENT_USER_ID,
    priorPrompt: 'Tighten the hero copy and bump the CTA contrast for the landing crop.',
    priorResponse:
      'Done — hero headline tightened and the CTA contrast now passes AA. Preview redeployed with the new crop.',
    readInput: { file_path: 'apps/web/src/pages/SettingsPage.tsx' },
    editInput: {
      file_path: 'apps/web/src/theme/tokens.ts',
      old_string: "surface: palette.slate[50],\n  toggle: 'none',",
      new_string:
        "surface: mode === 'dark' ? palette.slate[900] : palette.slate[50],\n  toggle: 'appearance',",
    },
  },
  gateway: {
    headerTitle: 'OAuth redirect loop — via Slack',
    prompt: GATEWAY_PROMPT,
    promptCreatedBy: demoUsers[6].user_id, // Sam ⚡ pinged from #eng-support
    priorPrompt: '@Agor can you summarize yesterday’s deploy failures for the standup thread?',
    priorResponse:
      'Posted the summary to the thread — three failures total, all traced to the flaky e2e runner. No product regressions.',
    readInput: { file_path: 'apps/web/src/auth/oauth-config.ts' },
    editInput: {
      file_path: 'apps/web/src/auth/oauth-config.ts',
      old_string: "redirectUrl: 'https://staging.agor.live/auth/callback',",
      new_string: "redirectUrl: 'https://staging.agor.live/api/auth/callback',",
    },
    channel: { type: 'slack', name: '#eng-support' },
  },
  collab: {
    headerTitle: 'Keyboard shortcuts for boards',
    prompt: MULTIPLAYER_PROMPT,
    promptCreatedBy: demoUsers[1].user_id, // Ari types the live prompt
    priorPrompt: 'Tighten the hero copy and bump the CTA contrast for the landing crop.',
    priorResponse:
      'Done — hero headline tightened and the CTA contrast now passes AA. Preview redeployed with the new crop.',
    readInput: { file_path: 'apps/web/src/hooks/useKeyboardShortcuts.ts' },
    editInput: {
      file_path: 'apps/web/src/hooks/useKeyboardShortcuts.ts',
      old_string: "bindings: { 'mod+b': toggleSidebar },",
      new_string:
        "bindings: { 'mod+b': toggleSidebar, ...boardHotkeys /* mod+1..9 → jumpToBoard */ },",
    },
    queuedPrompt: MULTIPLAYER_FOLLOWUP,
  },
};

// A finished earlier exchange so the panel reads as a real conversation from
// frame 0. Expanded — its closing response bubble fills the establish beat.
const buildPriorTask = (variant: StageVariantConfig): Task =>
  ({
    task_id: 'demo-session-task-prior',
    session_id: STAGE_SESSION_ID,
    created_by: demoUsers[1].user_id,
    full_prompt: variant.priorPrompt,
    status: TaskStatus.COMPLETED,
    message_range: {
      start_index: 0,
      end_index: 6,
      start_timestamp: demoNow,
      end_timestamp: demoNow,
    },
    tool_use_count: 4,
    git_state: { ref_at_start: STAGE_BRANCH.ref, sha_at_start: 'unknown' },
    duration_ms: 94_000,
    created_at: demoNow,
  }) as unknown as Task;

const stagedMessage = (
  taskId: string,
  id: string,
  index: number,
  role: MessageRole,
  content: unknown
): Message =>
  ({
    message_id: `demo-session-msg-${id}`,
    session_id: STAGE_SESSION_ID,
    task_id: taskId,
    type: role === MessageRole.USER ? 'user' : 'assistant',
    role,
    index,
    timestamp: demoNow,
    content_preview: '',
    content,
  }) as unknown as Message;

// The prior exchange stays expanded so the panel reads as a lived-in
// conversation from frame 0 (its closing response bubble fills the establish
// beat instead of an empty transcript).
const buildPriorMessages = (variant: StageVariantConfig): Message[] => [
  stagedMessage(
    'demo-session-task-prior',
    'prior-response',
    0,
    MessageRole.ASSISTANT,
    variant.priorResponse
  ),
];

interface DemoSessionStageProps {
  scene: SceneDefinition;
  t: number;
  /** Which story the staged panel tells. Defaults to the coding session. */
  variant?: StageVariant;
}

/** Right-docked session panel staged from real product leaf components. */
export const DemoSessionStage = ({ scene, t, variant = 'coding' }: DemoSessionStageProps) => {
  const { token } = theme.useToken();
  const config = STAGE_VARIANTS[variant];

  const phaseTrack = scene.uiFlags.sessionPhase;
  const phase = phaseTrack ? Math.round(phaseTrack.sample(t)) : -1;
  const composerText = scene.textTracks?.composer?.sample(t) ?? '';
  const responseText = scene.textTracks?.response?.sample(t) ?? '';
  // Loop-closure veil: a panel-colored overlay that masks the staged state's
  // reset back to the establish beat (see scenes/sessionsLoop.ts).
  const veil = scene.uiFlags.resetVeil ? scene.uiFlags.resetVeil.sample(t) : 0;

  const isRunning = phase >= 1 && phase < 5;
  const sessionStatus =
    phase >= 5 ? SessionStatus.COMPLETED : isRunning ? SessionStatus.RUNNING : SessionStatus.IDLE;

  // Collab variant: Jules's follow-up prompt lands as a QUEUED TASK (tasks —
  // not messages — are the queueable unit) once the scene's `queuedVisible`
  // flag flips on. Renders the product's queued-tasks drawer + Send badge.
  const queuedShown =
    Boolean(config.queuedPrompt) && (scene.uiFlags.queuedVisible?.sample(t) ?? 0) >= 0.5;
  const queuedTasks = useMemo(() => {
    if (!queuedShown || !config.queuedPrompt) return EMPTY_TASKS;
    return [
      {
        task_id: 'demo-session-task-queued',
        session_id: STAGE_SESSION_ID,
        created_by: demoUsers[5].user_id, // Jules
        full_prompt: config.queuedPrompt,
        status: 'queued',
        created_at: demoNow,
      } as unknown as Task,
    ];
  }, [queuedShown, config]);

  const session = useMemo(
    () => ({ ...BASE_SESSION, status: sessionStatus }) as Session,
    [sessionStatus]
  );

  const priorTask = useMemo(() => buildPriorTask(config), [config]);
  const priorMessages = useMemo(() => buildPriorMessages(config), [config]);

  // Live task + messages — a pure function of (phase, responseText).
  const liveTask = useMemo(() => {
    if (phase < 1) return null;
    return {
      task_id: 'demo-session-task-live',
      session_id: STAGE_SESSION_ID,
      created_by: config.promptCreatedBy,
      full_prompt: config.prompt,
      status: phase >= 5 ? TaskStatus.COMPLETED : TaskStatus.RUNNING,
      // Empty timestamps + no created_at keep TimerPill off the wall clock:
      // it renders nothing while running and the fixed duration once done.
      message_range: { start_index: 7, end_index: 7, start_timestamp: '' },
      tool_use_count: phase >= 4 ? 2 : phase >= 3 ? 1 : 0,
      git_state: { ref_at_start: STAGE_BRANCH.ref, sha_at_start: 'unknown' },
      ...(phase >= 5 ? { duration_ms: 3_400 } : {}),
    } as unknown as Task;
  }, [phase, config]);

  const liveMessages = useMemo(() => {
    if (phase < 1) return EMPTY_MESSAGES;
    const messages: Message[] = [
      stagedMessage('demo-session-task-live', 'prompt', 0, MessageRole.USER, config.prompt),
    ];
    // Tool chain — while only the automatic typing indicator shows (phase 2),
    // the "thinking beat" is TaskBlock's own running-task loader bubble.
    if (phase >= 3) {
      const chainBlocks: unknown[] = [
        {
          type: 'tool_use',
          id: 'demo-session-tool-read',
          name: 'Read',
          input: config.readInput,
        },
      ];
      if (phase >= 4) {
        chainBlocks.push({
          type: 'tool_use',
          id: 'demo-session-tool-edit',
          name: 'Edit',
          input: config.editInput,
        });
      }
      messages.push(
        stagedMessage('demo-session-task-live', 'chain', 1, MessageRole.ASSISTANT, chainBlocks)
      );
    }
    if (phase >= 4) {
      // Empty-content tool results flip the chain chips to ✓ without adding
      // visible "thought" rows (AgentChain skips empty result text).
      const results: unknown[] = [
        { type: 'tool_result', tool_use_id: 'demo-session-tool-read', content: '' },
      ];
      if (phase >= 5) {
        results.push({ type: 'tool_result', tool_use_id: 'demo-session-tool-edit', content: '' });
      }
      messages.push(
        stagedMessage('demo-session-task-live', 'results', 2, MessageRole.USER, results)
      );
    }
    if (responseText) {
      messages.push(
        stagedMessage('demo-session-task-live', 'response', 3, MessageRole.ASSISTANT, responseText)
      );
    }
    return messages;
  }, [phase, responseText, config]);

  const tokenBreakdown = useMemo(
    () => ({
      total: 48_240,
      input: 31_100,
      output: 17_140,
      cacheRead: 0,
      cacheCreation: 0,
      cost: 0,
    }),
    []
  );
  const latestContextWindow = useMemo(
    () => ({ used: 38_400, limit: 200_000, taskMetadata: null as unknown }),
    []
  );
  const modelConfig = useMemo(() => ({ mode: 'alias' as const, model: STAGE_MODEL }), []);

  const promptInputSlot = useMemo(
    () => (
      <AutocompleteTextarea
        value={composerText}
        onChange={NOOP}
        placeholder="Prompt here… @ for mentions, : for emoji"
        client={null}
        sessionId={STAGE_SESSION_ID}
        userById={USER_BY_ID}
        autoSize={{ minRows: 1, maxRows: 10 }}
      />
    ),
    [composerText]
  );

  if (!phaseTrack) return null;

  const statusBadge =
    sessionStatus === SessionStatus.RUNNING
      ? ('processing' as const)
      : sessionStatus === SessionStatus.COMPLETED
        ? ('success' as const)
        : ('default' as const);

  return (
    <div
      data-testid="demo-session-stage"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: SESSION_PANEL_WIDTH,
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgElevated,
        borderLeft: `1px solid ${token.colorBorder}`,
        boxShadow: '-24px 0 70px rgba(0, 0, 0, 0.38)',
      }}
    >
      {/* Header — mirrors SessionPanel's header row */}
      <div
        style={{
          flexShrink: 0,
          padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px`,
          borderBottom: `1px solid ${token.colorBorder}`,
          background: token.colorBgContainer,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 1, minWidth: 0 }}>
            <div style={{ flexShrink: 0 }}>
              <ToolIcon tool="claude-code" size={40} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Typography.Text strong style={{ fontSize: 18, display: 'block' }}>
                {config.headerTitle}
              </Typography.Text>
              <Badge status={statusBadge} text={sessionStatus.toUpperCase()} />
              <div style={{ marginTop: token.sizeUnit }}>
                <CreatedByTag
                  createdBy={demoUsers[1].user_id}
                  currentUserId={CURRENT_USER_ID}
                  userById={USER_BY_ID}
                  prefix="Created by"
                />
              </div>
            </div>
          </div>
          <Space size={4}>
            <Tooltip title="More actions">
              <Button type="text" icon={<EllipsisOutlined />} />
            </Tooltip>
            <Tooltip title="Search session">
              <Button type="text" icon={<SearchOutlined />} />
            </Tooltip>
            <Tooltip title="Close Panel">
              <Button type="text" icon={<CloseOutlined />} style={{ marginLeft: token.sizeUnit }} />
            </Tooltip>
          </Space>
        </div>
      </div>

      {/* Body — pills row, transcript, footer (SessionPanel's body layout) */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px 0`,
        }}
      >
        <div
          style={{
            marginBottom: token.sizeUnit,
            display: 'flex',
            alignItems: 'center',
            gap: token.sizeUnit * 2,
          }}
        >
          <Space size={8} wrap style={{ flex: 1 }}>
            <BranchHeaderPill repo={demoRepo} branch={STAGE_BRANCH} identityLink={null} compact />
            {config.channel && (
              <ChannelPill
                channelType={config.channel.type}
                channelName={config.channel.name}
                style={{ marginInlineEnd: 0 }}
              />
            )}
            {STAGE_BRANCH.issue_url && (
              <IssuePill issueUrl={STAGE_BRANCH.issue_url} currentRepo={demoRepo} />
            )}
            {STAGE_BRANCH.pull_request_url && (
              <PullRequestPill prUrl={STAGE_BRANCH.pull_request_url} currentRepo={demoRepo} />
            )}
          </Space>
        </div>
        <Divider style={{ margin: `${token.sizeUnit * 2}px 0` }} />

        {/* Transcript — bottom-anchored like a pinned conversation. Real
            TaskBlocks; scrolling is never needed because the choreography
            fits the panel. */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}
        >
          <TaskBlock
            task={priorTask}
            agentic_tool="claude-code"
            sessionModel={STAGE_MODEL}
            userById={USER_BY_ID}
            currentUserId={CURRENT_USER_ID}
            isExpanded
            onExpandChange={NOOP}
            sessionId={STAGE_SESSION_ID}
            taskMessages={priorMessages}
            taskMessagesLoaded
            onLoadTaskMessages={NOOP}
            onUnloadTaskMessages={NOOP}
            branchName={STAGE_BRANCH.name}
          />
          {liveTask && (
            <TaskBlock
              task={liveTask}
              agentic_tool="claude-code"
              sessionModel={STAGE_MODEL}
              userById={USER_BY_ID}
              currentUserId={CURRENT_USER_ID}
              isExpanded
              onExpandChange={NOOP}
              sessionId={STAGE_SESSION_ID}
              taskMessages={liveMessages}
              taskMessagesLoaded
              onLoadTaskMessages={NOOP}
              onUnloadTaskMessages={NOOP}
              branchName={STAGE_BRANCH.name}
              isLatestTask
            />
          )}
        </div>

        {/* Queued Tasks drawer — mirrors SessionPanelContent's drawer (the
            queue is task-centric; full prompt lives on task.full_prompt). */}
        {queuedTasks.length > 0 && (
          <div
            style={{
              flexShrink: 0,
              background: token.colorBgElevated,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              borderTopLeftRadius: token.borderRadiusLG,
              borderTopRightRadius: token.borderRadiusLG,
              padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px`,
              marginLeft: -token.sizeUnit * 6 + token.sizeUnit * 2,
              marginRight: -token.sizeUnit * 6 + token.sizeUnit * 2,
              marginTop: token.sizeUnit * 2,
              boxShadow: `0 -2px 8px ${token.colorBgMask}`,
            }}
          >
            <Typography.Text
              type="secondary"
              style={{
                fontSize: token.fontSizeSM,
                display: 'block',
                marginBottom: token.sizeUnit * 2,
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              Queued Tasks ({queuedTasks.length})
            </Typography.Text>
            {queuedTasks.map((task, idx) => (
              <div
                key={task.task_id}
                style={{
                  background: token.colorBgContainer,
                  padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 3}px`,
                  borderRadius: token.borderRadius,
                  border: `1px solid ${token.colorBorder}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: token.sizeUnit * 2,
                }}
              >
                <Typography.Text ellipsis style={{ flex: 1 }}>
                  <span style={{ color: token.colorTextSecondary, marginRight: token.sizeUnit }}>
                    {idx + 1}.
                  </span>
                  {task.full_prompt}
                </Typography.Text>
                <Space size={4}>
                  <Button type="text" size="small" icon={<CopyOutlined />} />
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                </Space>
              </div>
            ))}
          </div>
        )}

        {/* Footer — the real SessionFooter with the composer slotted in */}
        <SessionFooter
          session={session}
          footerTimerTask={null}
          tokenBreakdown={tokenBreakdown}
          latestContextWindow={latestContextWindow}
          sessionMcpServerIds={[]}
          unauthedMcpServers={EMPTY_MCP_SERVERS}
          mcpServerById={MCP_SERVER_BY_ID}
          userAuthenticatedMcpServerIds={AUTHED_MCP_IDS}
          isRunning={isRunning}
          isStopping={false}
          stopRequestInFlight={false}
          hasInput={composerText.trim().length > 0}
          connectionDisabled={false}
          effortLevel={'high' as EffortLevel}
          permissionMode={'acceptEdits' as PermissionMode}
          codexSandboxMode={'workspace-write' as CodexSandboxMode}
          codexApprovalPolicy={'on-request' as CodexApprovalPolicy}
          queuedTasks={queuedTasks}
          client={null}
          modelConfig={modelConfig}
          onModelConfigChange={NOOP}
          onSendPrompt={NOOP}
          onStop={NOOP}
          onFork={NOOP}
          onBtwSend={NOOP}
          onSpawnOpen={NOOP}
          onAttachFiles={NOOP}
          onUploadOpen={NOOP}
          onEffortChange={NOOP}
          onPermissionModeChange={NOOP}
          onCodexPermissionChange={NOOP}
          promptInputSlot={promptInputSlot}
        />
      </div>

      {/* Loop-closure veil — fades the panel to its own background color while
          the staged transcript state resets, then lifts (scene-driven). */}
      {veil > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 40,
            background: token.colorBgElevated,
            opacity: veil,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
};
