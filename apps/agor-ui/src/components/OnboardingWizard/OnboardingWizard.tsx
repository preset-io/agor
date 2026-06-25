/**
 * OnboardingWizard — redesigned 5-step first-run flow.
 *
 * Steps: persona → llm → workspace → integrations → done
 */

import type {
  AgenticToolName,
  AuthCheckResult,
  Board,
  Branch,
  CreateLocalRepoRequest,
  CreateRepoRequest,
  Repo,
  UpdateUserInput,
  User,
  UserPreferences,
} from '@agor-live/client';
import { TOOL_API_KEY_NAMES } from '@agor-live/client';
import {
  CheckCircleOutlined,
  CheckOutlined,
  LeftOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { Alert, Button, Input, Modal, Spin, Tag, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NewSessionConfig } from '../NewSessionModal/NewSessionModal';

const { Text, Title, Paragraph } = Typography;
const { useToken } = theme;

// ─── Types ──────────────────────────────────────────────────────────────────

export type WizardStep = 'persona' | 'llm' | 'workspace' | 'integrations' | 'done';
type WizardPath = 'assistant';
type AuthMethod = 'api-key' | 'claude-subscription-token' | 'codex-cli-auth';
type IntegrationId = 'slack' | 'github' | 'linear' | 'jira' | 'notion';

// ─── Constants ───────────────────────────────────────────────────────────────

const STEPS: WizardStep[] = ['persona', 'llm', 'workspace', 'integrations', 'done'];

const STEP_META: Record<WizardStep, { number: number; label: string; skippable: boolean }> = {
  persona: { number: 1, label: 'You', skippable: true },
  llm: { number: 2, label: 'AI', skippable: true },
  workspace: { number: 3, label: 'Workspace', skippable: true },
  integrations: { number: 4, label: 'Integrations', skippable: true },
  done: { number: 5, label: "You're ready", skippable: false },
};

const PERSONAS = [
  {
    id: 'developer',
    emoji: '🔨',
    title: 'I write code',
    role: 'Developer',
    desc: 'I want AI to handle parts of my work',
  },
  {
    id: 'pm',
    emoji: '📋',
    title: 'I manage the work',
    role: 'PM / designer',
    desc: 'I coordinate teams, not the code',
  },
  {
    id: 'lead',
    emoji: '🎯',
    title: 'I lead a team',
    role: 'Engineering lead',
    desc: 'Running multiple AI agents',
  },
  {
    id: 'solo',
    emoji: '⚡',
    title: 'Just ship it',
    role: 'Solo builder',
    desc: 'Minimal setup, maximum output',
  },
];

interface LlmOption {
  id: string;
  agent: AgenticToolName;
  symbol: string;
  provider: string;
  title: string;
  description: string;
  placeholder: string;
  keyLink: string | null;
  keyLinkLabel: string | null;
  recommended?: boolean;
}

const LLM_OPTIONS: LlmOption[] = [
  {
    id: 'claude',
    agent: 'claude-code',
    symbol: '✦',
    provider: 'Anthropic',
    title: 'Claude',
    description: 'Best for complex coding, long context, and nuanced reasoning',
    placeholder: 'sk-ant-api03-…',
    keyLink: 'https://console.anthropic.com/',
    keyLinkLabel: 'console.anthropic.com',
    recommended: true,
  },
  {
    id: 'openai',
    agent: 'codex',
    symbol: '⬡',
    provider: 'OpenAI',
    title: 'GPT',
    description: 'Fast and strong at structured reasoning and code generation',
    placeholder: 'sk-proj-…',
    keyLink: 'https://platform.openai.com/api-keys',
    keyLinkLabel: 'platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    agent: 'gemini',
    symbol: '◈',
    provider: 'Google',
    title: 'Gemini',
    description: 'Excellent at multimodal tasks and very long context windows',
    placeholder: 'AIzaSy…',
    keyLink: 'https://aistudio.google.com/',
    keyLinkLabel: 'aistudio.google.com',
  },
  {
    id: 'custom',
    agent: 'opencode',
    symbol: '⚙',
    provider: '',
    title: 'Custom',
    description: 'Use any model with an OpenAI-compatible API endpoint',
    placeholder: 'https://…',
    keyLink: null,
    keyLinkLabel: null,
  },
];

interface IntegrationConfig {
  id: IntegrationId;
  name: string;
  emoji: string;
  description: string;
  valueProp: string;
  featured?: boolean;
}

const INTEGRATIONS: IntegrationConfig[] = [
  {
    id: 'slack',
    name: 'Slack',
    emoji: '💬',
    description: 'Post updates, get notifications, and trigger workflows',
    valueProp:
      'Your AI can post session summaries, alert you on blockers, and let you send prompts from Slack.',
    featured: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    description: 'Create PRs, review code, and sync issues automatically',
    valueProp: 'Your AI can open pull requests, push commits, and respond to review comments.',
  },
  {
    id: 'linear',
    name: 'Linear',
    emoji: '🎯',
    description: 'Link sessions to issues and update status automatically',
    valueProp: 'Your AI can pick up Linear issues and mark them done when sessions complete.',
  },
  {
    id: 'jira',
    name: 'Jira',
    emoji: '📋',
    description: 'Create and update Jira issues from your AI sessions',
    valueProp: 'Your AI can create tickets, update status, and log work automatically.',
  },
  {
    id: 'notion',
    name: 'Notion',
    emoji: '📝',
    description: 'Sync notes and documentation to Notion automatically',
    valueProp: 'Your AI can write docs, update pages, and keep your knowledge base current.',
  },
];

function hasAnyLlmKey(user: User | null | undefined): boolean {
  if (!user) return false;
  const claude = user.agentic_tools?.['claude-code'];
  const codex = user.agentic_tools?.codex;
  const gemini = user.agentic_tools?.gemini;
  return !!(
    claude?.ANTHROPIC_API_KEY ||
    claude?.CLAUDE_CODE_OAUTH_TOKEN ||
    codex?.OPENAI_API_KEY ||
    gemini?.GEMINI_API_KEY ||
    user.env_vars?.ANTHROPIC_API_KEY ||
    user.env_vars?.OPENAI_API_KEY ||
    user.env_vars?.GEMINI_API_KEY
  );
}

function keyNameForAgent(agent: AgenticToolName, authMethod: AuthMethod = 'api-key'): string {
  if (agent === 'claude-code' && authMethod === 'claude-subscription-token') {
    return 'CLAUDE_CODE_OAUTH_TOKEN';
  }
  return TOOL_API_KEY_NAMES[agent] ?? 'ANTHROPIC_API_KEY';
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface OnboardingWizardProps {
  open: boolean;
  onComplete: (result: {
    branchId: string;
    sessionId: string;
    boardId: string;
    path: WizardPath;
  }) => void;

  repoById: Map<string, Repo>;
  branchById: Map<string, Branch>;
  boardById: Map<string, Board>;
  user?: User | null;
  // biome-ignore lint/suspicious/noExplicitAny: AgorClient type varies across package boundaries.
  client: any;

  onCreateRepo: (data: CreateRepoRequest) => Promise<void>;
  onCreateLocalRepo: (data: CreateLocalRepoRequest) => void | Promise<void>;
  onCreateBranch: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      refType?: 'branch' | 'tag';
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      boardId?: string;
      custom_context?: Record<string, unknown>;
      notes?: string | null;
      position?: { x: number; y: number };
    }
  ) => Promise<Branch | null>;
  onCreateSession: (config: NewSessionConfig, boardId: string) => Promise<string | null>;
  onUpdateUser: (userId: string, updates: UpdateUserInput) => Promise<void>;
  onUpdateBranch?: (branchId: string, updates: Partial<Branch>) => Promise<void>;

  onCheckAuth?: (tool: AgenticToolName, apiKey?: string) => Promise<AuthCheckResult>;

  assistantPending?: boolean;
  frameworkRepoUrl?: string;

  /** Re-open wizard starting at a specific step (used by persistent banners). */
  initialStep?: WizardStep;
}

// ─── Static glass layer (non-token values intentionally kept) ─────────────────

const MODAL_BG = '#0d1426';
const GLASS_CARD_BG = 'rgba(255,255,255,0.04)';
const GLASS_CARD_BORDER = '1px solid rgba(255,255,255,0.08)';

// ─── Component ────────────────────────────────────────────────────────────────

export function OnboardingWizard({
  open,
  onComplete,
  boardById,
  user,
  client,
  onCreateRepo: _onCreateRepo,
  onCreateBranch: _onCreateBranch,
  onCreateSession: _onCreateSession,
  onUpdateUser,
  onCheckAuth: _onCheckAuth,
  initialStep,
}: OnboardingWizardProps) {
  void _onCreateRepo;
  void _onCreateBranch;
  void _onCreateSession;
  void _onCheckAuth;

  const { token } = useToken();

  // ── Token-derived styles (live, theme-aware) ────────────────────────────
  const PRIMARY = token.colorPrimary;
  const TEXT_PRIMARY = token.colorText;
  const TEXT_SECONDARY = token.colorTextSecondary;
  const TEXT_MUTED = token.colorTextTertiary;
  const SUCCESS_GREEN = token.colorSuccess;
  const CARD_SELECTED_BG = token.colorPrimaryBg;
  const CARD_SELECTED_BORDER = `1px solid ${token.colorPrimaryBorder}`;
  const CARD_SELECTED_SHADOW = `0 0 0 2px ${token.colorPrimaryBgHover}`;

  // ── Step state ──────────────────────────────────────────────────────────
  const [currentStep, setCurrentStep] = useState<WizardStep>(initialStep || 'persona');

  // ── Step 1: persona ─────────────────────────────────────────────────────
  const [selectedPersona, setSelectedPersona] = useState<string | null>(null);

  // ── Step 2: LLM ─────────────────────────────────────────────────────────
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [authMethod] = useState<AuthMethod>('api-key');
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);

  // ── Step 3: workspace ───────────────────────────────────────────────────
  const [boardName, setBoardName] = useState('My project board');
  const [repoUrl, setRepoUrl] = useState('');
  const [createdBoardId, setCreatedBoardId] = useState<string | null>(null);
  const [boardCreating, setBoardCreating] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  // ── Step 4: integrations ─────────────────────────────────────────────────
  const [activeIntegration, setActiveIntegration] = useState<IntegrationId | null>(null);
  const [integrationInputs, setIntegrationInputs] = useState<Record<string, string>>({});
  const [slackConnecting, setSlackConnecting] = useState(false);
  const [slackConnected, setSlackConnected] = useState(false);
  const [hoveredIntegration, setHoveredIntegration] = useState<IntegrationId | null>(null);

  // ── Reset on open ────────────────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      const startStep = initialStep || 'persona';
      setCurrentStep(startStep);
      setSelectedPersona(null);
      setApiKey('');
      setLlmError(null);
      setLlmSaving(false);
      setBoardError(null);
      setBoardCreating(false);
      setActiveIntegration(null);
      setIntegrationInputs({});
      setSlackConnecting(false);
      setSlackConnected(false);
      setHoveredIntegration(null);
      // Pre-select LLM if user already has one configured
      if (hasAnyLlmKey(user)) {
        const claude = user?.agentic_tools?.['claude-code'];
        const codex = user?.agentic_tools?.codex;
        const gemini = user?.agentic_tools?.gemini;
        if (
          claude?.ANTHROPIC_API_KEY ||
          claude?.CLAUDE_CODE_OAUTH_TOKEN ||
          user?.env_vars?.ANTHROPIC_API_KEY
        ) {
          setSelectedAgent('claude-code');
        } else if (codex?.OPENAI_API_KEY || user?.env_vars?.OPENAI_API_KEY) {
          setSelectedAgent('codex');
        } else if (gemini?.GEMINI_API_KEY || user?.env_vars?.GEMINI_API_KEY) {
          setSelectedAgent('gemini');
        }
      } else {
        setSelectedAgent(null);
      }
      // Preserve board name from user preferences if exists
      const existingBoardId = user?.preferences?.mainBoardId;
      if (!existingBoardId) {
        setBoardName('My project board');
        setRepoUrl('');
        setCreatedBoardId(null);
      } else {
        setCreatedBoardId(existingBoardId);
      }
    }
  }, [open, initialStep, user]);

  // ─── Derived values ──────────────────────────────────────────────────────

  const stepIndex = STEPS.indexOf(currentStep);
  const meta = STEP_META[currentStep];

  const agentHasKey = useCallback(
    (agent: AgenticToolName): boolean => {
      if (!user) return false;
      const claude = user.agentic_tools?.['claude-code'];
      const codex = user.agentic_tools?.codex;
      const gemini = user.agentic_tools?.gemini;
      if (agent === 'claude-code') {
        return !!(
          claude?.ANTHROPIC_API_KEY ||
          claude?.CLAUDE_CODE_OAUTH_TOKEN ||
          user.env_vars?.ANTHROPIC_API_KEY
        );
      }
      if (agent === 'codex') return !!(codex?.OPENAI_API_KEY || user.env_vars?.OPENAI_API_KEY);
      if (agent === 'gemini') return !!(gemini?.GEMINI_API_KEY || user.env_vars?.GEMINI_API_KEY);
      if (agent === 'opencode') return hasAnyLlmKey(user);
      return false;
    },
    [user]
  );

  const existingBoardId = user?.preferences?.mainBoardId || null;
  const existingBoard = existingBoardId ? boardById.get(existingBoardId) : null;
  const hasExistingBoard = !!(existingBoard || createdBoardId);

  const primaryEnabled = useMemo(() => {
    switch (currentStep) {
      case 'persona':
        return true; // persona is optional — never block navigation
      case 'llm': {
        if (!selectedAgent) return false;
        if (agentHasKey(selectedAgent)) return true;
        return apiKey.length > 8;
      }
      case 'workspace':
        return boardName.trim().length > 0;
      case 'integrations':
        return true;
      case 'done':
        return true;
    }
  }, [currentStep, selectedAgent, agentHasKey, apiKey, boardName]);

  const primaryLabel = useMemo(() => {
    switch (currentStep) {
      case 'persona':
        return selectedPersona ? 'This is me →' : 'Continue →';
      case 'llm':
        return 'Connect →';
      case 'workspace':
        return hasExistingBoard ? 'Keep going →' : 'Create board →';
      case 'integrations':
        return 'Continue →';
      case 'done':
        return 'Open my board →';
    }
  }, [currentStep, hasExistingBoard, selectedPersona]);

  const canGoBack = stepIndex > 0 && currentStep !== 'done';
  const isSkippable = meta.skippable && currentStep !== 'done';

  // ─── Handlers ────────────────────────────────────────────────────────────

  const saveOnboardingProgress = useCallback(
    (updates: Record<string, unknown>) => {
      if (!user) return;
      const current = (user.preferences?.onboarding ?? {}) as Record<string, unknown>;
      const prefs: UserPreferences = {
        ...user.preferences,
        onboarding: { ...current, ...updates },
      } as UserPreferences;
      onUpdateUser(user.user_id, { preferences: prefs });
    },
    [onUpdateUser, user]
  );

  const goToStep = useCallback((step: WizardStep) => {
    setCurrentStep(step);
    setActiveIntegration(null);
  }, []);

  const handleBack = useCallback(() => {
    if (stepIndex > 0) goToStep(STEPS[stepIndex - 1]);
  }, [stepIndex, goToStep]);

  const handleSkip = useCallback(() => {
    if (currentStep === 'done') return;
    goToStep(STEPS[stepIndex + 1]);
  }, [currentStep, stepIndex, goToStep]);

  const handlePrimary = useCallback(async () => {
    switch (currentStep) {
      case 'persona': {
        if (selectedPersona) {
          saveOnboardingProgress({ persona: selectedPersona });
        }
        goToStep('llm');
        break;
      }
      case 'llm': {
        if (!selectedAgent) return;
        if (agentHasKey(selectedAgent)) {
          goToStep('workspace');
          return;
        }
        if (!user || !apiKey.trim()) return;
        setLlmSaving(true);
        setLlmError(null);
        const keyName = keyNameForAgent(selectedAgent, authMethod);
        const targetTool: AgenticToolName =
          selectedAgent === 'opencode' ? 'claude-code' : selectedAgent;
        try {
          await onUpdateUser(user.user_id, {
            agentic_tools: {
              [targetTool]: { [keyName]: apiKey.trim() },
            } as UpdateUserInput['agentic_tools'],
          });
          goToStep('workspace');
        } catch (err) {
          setLlmError(
            `Failed to save API key: ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          setLlmSaving(false);
        }
        break;
      }
      case 'workspace': {
        if (hasExistingBoard) {
          goToStep('integrations');
          return;
        }
        if (!client || !boardName.trim()) return;
        setBoardCreating(true);
        setBoardError(null);
        try {
          const board = await client.service('boards').create({
            name: boardName.trim(),
          });
          const newBoardId = board?.board_id ?? null;
          setCreatedBoardId(newBoardId);
          if (newBoardId && user) {
            saveOnboardingProgress({ boardId: newBoardId });
          }
          goToStep('integrations');
        } catch (err) {
          setBoardError(err instanceof Error ? err.message : 'Failed to create board');
        } finally {
          setBoardCreating(false);
        }
        break;
      }
      case 'integrations': {
        if (activeIntegration) {
          setActiveIntegration(null);
        } else {
          goToStep('done');
        }
        break;
      }
      case 'done': {
        const boardIdToUse = createdBoardId || existingBoardId || '';
        onComplete({ branchId: '', sessionId: '', boardId: boardIdToUse, path: 'assistant' });
        break;
      }
    }
  }, [
    currentStep,
    selectedPersona,
    selectedAgent,
    agentHasKey,
    user,
    apiKey,
    authMethod,
    onUpdateUser,
    hasExistingBoard,
    client,
    boardName,
    saveOnboardingProgress,
    activeIntegration,
    createdBoardId,
    existingBoardId,
    onComplete,
    goToStep,
  ]);

  const handleSlackOAuth = useCallback(async () => {
    setSlackConnecting(true);
    // TODO: Wire to real Slack OAuth flow (MCP server creation)
    await new Promise((resolve) => setTimeout(resolve, 1400));
    setSlackConnecting(false);
    setSlackConnected(true);
  }, []);

  // ─── Progress dots ────────────────────────────────────────────────────────

  const renderProgressDots = () => (
    <div style={{ textAlign: 'center', marginBottom: 6 }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        {STEPS.map((step, index) => {
          const isCompleted = index < stepIndex;
          const isCurrent = index === stepIndex;
          return (
            <div
              key={step}
              style={{
                width: isCurrent ? 12 : 8,
                height: isCurrent ? 12 : 8,
                borderRadius: '50%',
                background: isCompleted || isCurrent ? PRIMARY : 'rgba(255,255,255,0.2)',
                boxShadow: isCurrent ? `0 0 8px ${token.colorPrimaryActive}` : undefined,
                transition: 'all 0.2s ease',
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
      <div>
        <Text style={{ fontSize: 12, color: TEXT_MUTED }}>
          {meta.number} / 5 — {meta.label}
          {meta.skippable && <span style={{ color: TEXT_MUTED }}> · optional</span>}
        </Text>
      </div>
    </div>
  );

  // ─── Step renderers ───────────────────────────────────────────────────────

  const renderPersona = () => (
    <div>
      <Title level={3} style={{ color: TEXT_PRIMARY, marginBottom: 8, marginTop: 0 }}>
        Let's make this yours.
      </Title>
      <Paragraph style={{ color: TEXT_SECONDARY, marginBottom: 24 }}>
        How do you work? This helps us understand who's using Agor and what to build next.
      </Paragraph>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
        }}
      >
        {PERSONAS.map((persona) => {
          const isSelected = selectedPersona === persona.id;
          return (
            <button
              key={persona.id}
              type="button"
              onClick={() => setSelectedPersona(persona.id)}
              style={{
                background: isSelected ? CARD_SELECTED_BG : GLASS_CARD_BG,
                border: isSelected ? CARD_SELECTED_BORDER : GLASS_CARD_BORDER,
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                borderRadius: 12,
                padding: '16px',
                cursor: 'pointer',
                textAlign: 'left',
                boxShadow: isSelected
                  ? CARD_SELECTED_SHADOW
                  : 'inset 0 1px 0 rgba(255,255,255,0.06)',
                transition: 'all 0.15s ease',
                width: '100%',
              }}
            >
              <div style={{ fontSize: 24, marginBottom: 8 }}>{persona.emoji}</div>
              <div style={{ color: TEXT_PRIMARY, fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                {persona.title}
              </div>
              <div style={{ color: TEXT_SECONDARY, fontSize: 12, marginBottom: 4 }}>
                {persona.role}
              </div>
              <div style={{ color: TEXT_MUTED, fontSize: 12 }}>{persona.desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderLlm = () => {
    return (
      <div>
        <Title level={3} style={{ color: TEXT_PRIMARY, marginBottom: 8, marginTop: 0 }}>
          Choose your AI.
        </Title>
        <Paragraph style={{ color: TEXT_SECONDARY, marginBottom: 24 }}>
          Agor works with multiple AI models. Pick one — you can add more later in Settings.
        </Paragraph>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {LLM_OPTIONS.map((option) => {
            const isSelected = selectedAgent === option.agent;
            const hasKey = agentHasKey(option.agent);
            const optionKeyName = keyNameForAgent(option.agent, authMethod);
            return (
              <div
                key={option.id}
                style={{
                  background: isSelected ? CARD_SELECTED_BG : GLASS_CARD_BG,
                  border: isSelected ? CARD_SELECTED_BORDER : GLASS_CARD_BORDER,
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  borderRadius: 10,
                  boxShadow: isSelected
                    ? CARD_SELECTED_SHADOW
                    : 'inset 0 1px 0 rgba(255,255,255,0.06)',
                  transition: 'all 0.15s ease',
                  overflow: 'hidden',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelectedAgent(option.agent);
                    setApiKey('');
                    setLlmError(null);
                  }}
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    padding: '14px 16px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      fontSize: 20,
                      flexShrink: 0,
                      color: isSelected ? PRIMARY : TEXT_SECONDARY,
                    }}
                  >
                    {option.symbol}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                    >
                      <span style={{ color: TEXT_PRIMARY, fontWeight: 600, fontSize: 14 }}>
                        {option.title}
                      </span>
                      {option.provider && (
                        <span style={{ color: TEXT_MUTED, fontSize: 12 }}>
                          by {option.provider}
                        </span>
                      )}
                      {option.recommended && (
                        <Tag
                          color="processing"
                          style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px' }}
                        >
                          Recommended
                        </Tag>
                      )}
                      {hasKey && (
                        <Tag
                          color="success"
                          style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px' }}
                        >
                          Connected
                        </Tag>
                      )}
                    </div>
                    <div style={{ color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 }}>
                      {option.description}
                    </div>
                  </div>
                  {isSelected ? (
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: PRIMARY,
                        flexShrink: 0,
                        marginTop: 2,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <CheckOutlined style={{ color: '#fff', fontSize: 10 }} />
                    </div>
                  ) : (
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        border: '1.5px solid rgba(255,255,255,0.2)',
                        flexShrink: 0,
                        marginTop: 2,
                      }}
                    />
                  )}
                </button>

                {isSelected && !hasKey && (
                  <div
                    style={{
                      padding: '0 16px 16px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: 12,
                        marginBottom: 8,
                      }}
                    >
                      <Text style={{ color: TEXT_PRIMARY, fontSize: 13, fontWeight: 500 }}>
                        {optionKeyName}
                      </Text>
                      {option.keyLink && (
                        <Typography.Link
                          href={option.keyLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: PRIMARY }}
                        >
                          Get your key at {option.keyLinkLabel} →
                        </Typography.Link>
                      )}
                    </div>
                    <Input.Password
                      placeholder={option.placeholder}
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setLlmError(null);
                      }}
                      style={{
                        background: 'rgba(0,0,0,0.3)',
                        borderColor: 'rgba(255,255,255,0.12)',
                        fontFamily: 'monospace',
                        fontSize: 13,
                      }}
                    />
                    <Text
                      style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 8, display: 'block' }}
                    >
                      🔒 Stored securely — never shared or logged.
                    </Text>
                  </div>
                )}

                {isSelected && hasKey && (
                  <div
                    style={{
                      padding: '10px 16px 14px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <CheckCircleOutlined style={{ color: SUCCESS_GREEN, fontSize: 14 }} />
                    <Text style={{ color: SUCCESS_GREEN, fontSize: 13 }}>
                      {option.title} is already connected — you&apos;re all set.
                    </Text>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {llmError && <Alert type="error" message={llmError} showIcon style={{ marginTop: 16 }} />}
      </div>
    );
  };

  const renderWorkspace = () => (
    <div>
      <Title level={3} style={{ color: TEXT_PRIMARY, marginBottom: 8, marginTop: 0 }}>
        Set up your workspace.
      </Title>
      <Paragraph style={{ color: TEXT_SECONDARY, marginBottom: 20 }}>
        Connect a repo and name your board. Both can be changed anytime.
      </Paragraph>

      {/* Concept pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
        {[
          { emoji: '🌿', term: 'Branch', def: 'isolated workspace per task' },
          { emoji: '💬', term: 'Session', def: 'conversation with your AI' },
          { emoji: '📋', term: 'Board', def: 'kanban view of all branches' },
        ].map(({ emoji, term, def }) => (
          <div
            key={term}
            style={{
              background: token.colorFillAlter,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 20,
              padding: '4px 12px',
              fontSize: 12,
              color: TEXT_SECONDARY,
            }}
          >
            {emoji} <span style={{ color: TEXT_PRIMARY, fontWeight: 500 }}>{term}</span> — {def}
          </div>
        ))}
      </div>

      {hasExistingBoard ? (
        <div
          style={{
            background: 'rgba(16,185,129,0.08)',
            border: '1px solid rgba(16,185,129,0.25)',
            borderRadius: 10,
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <CheckCircleOutlined style={{ color: SUCCESS_GREEN, fontSize: 18 }} />
          <div>
            <Text style={{ color: SUCCESS_GREEN, fontWeight: 500, fontSize: 14 }}>
              Board already set up
            </Text>
            <div>
              <Text style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
                {existingBoard?.name || 'Your board is ready.'}
              </Text>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Text
              style={{ color: TEXT_SECONDARY, fontSize: 13, display: 'block', marginBottom: 6 }}
            >
              Repo URL <span style={{ color: TEXT_MUTED, fontSize: 12 }}>optional</span>
            </Text>
            <Input
              placeholder="https://github.com/you/your-repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              style={{
                background: 'rgba(0,0,0,0.3)',
                borderColor: 'rgba(255,255,255,0.12)',
              }}
            />
          </div>
          <div>
            <Text
              style={{ color: TEXT_SECONDARY, fontSize: 13, display: 'block', marginBottom: 6 }}
            >
              Board name
            </Text>
            <Input
              placeholder="My project board"
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              style={{
                background: 'rgba(0,0,0,0.3)',
                borderColor: 'rgba(255,255,255,0.12)',
              }}
            />
          </div>
        </div>
      )}

      {boardError && <Alert type="error" message={boardError} showIcon style={{ marginTop: 16 }} />}
    </div>
  );

  const renderIntegrationSubPanel = (integration: IntegrationConfig) => {
    const inputKey = `${integration.id}-input`;
    const inputValue = integrationInputs[inputKey] || '';

    const subPrimaryEnabled = integration.id === 'slack' ? slackConnected : inputValue.length > 0;

    return (
      <div>
        {/* Value prop callout */}
        <div
          style={{
            background: token.colorFillAlter,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            padding: '12px 14px',
            marginBottom: 20,
          }}
        >
          <Text style={{ color: TEXT_SECONDARY, fontSize: 13 }}>{integration.valueProp}</Text>
        </div>

        {integration.id === 'slack' && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            {slackConnected ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  padding: '14px 0',
                }}
              >
                <CheckCircleOutlined style={{ color: SUCCESS_GREEN, fontSize: 20 }} />
                <Text style={{ color: SUCCESS_GREEN, fontWeight: 500 }}>
                  Slack connected successfully!
                </Text>
              </div>
            ) : (
              <Button
                onClick={handleSlackOAuth}
                loading={slackConnecting}
                style={{
                  background: '#4A154B',
                  borderColor: '#4A154B',
                  color: '#fff',
                  height: 44,
                  paddingLeft: 24,
                  paddingRight: 24,
                  fontSize: 15,
                }}
                size="large"
              >
                {slackConnecting ? 'Connecting…' : '💬 Connect with Slack'}
              </Button>
            )}
          </div>
        )}

        {integration.id === 'github' && (
          <div>
            <Text
              style={{ color: TEXT_SECONDARY, fontSize: 13, display: 'block', marginBottom: 8 }}
            >
              Personal access token{' '}
              <Typography.Link
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, color: PRIMARY }}
              >
                github.com/settings/tokens →
              </Typography.Link>
            </Text>
            <Input.Password
              placeholder="ghp_…"
              value={inputValue}
              onChange={(e) => setIntegrationInputs((p) => ({ ...p, [inputKey]: e.target.value }))}
              style={{
                background: 'rgba(0,0,0,0.3)',
                borderColor: 'rgba(255,255,255,0.12)',
                fontFamily: 'monospace',
              }}
            />
            <Text style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 6, display: 'block' }}>
              Needs: repo, read:org permissions
            </Text>
          </div>
        )}

        {integration.id === 'linear' && (
          <div>
            <Text
              style={{ color: TEXT_SECONDARY, fontSize: 13, display: 'block', marginBottom: 8 }}
            >
              API key{' '}
              <Typography.Link
                href="https://linear.app/settings/api"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, color: PRIMARY }}
              >
                linear.app/settings/api →
              </Typography.Link>
            </Text>
            <Input.Password
              placeholder="lin_api_…"
              value={inputValue}
              onChange={(e) => setIntegrationInputs((p) => ({ ...p, [inputKey]: e.target.value }))}
              style={{
                background: 'rgba(0,0,0,0.3)',
                borderColor: 'rgba(255,255,255,0.12)',
                fontFamily: 'monospace',
              }}
            />
          </div>
        )}

        {integration.id === 'jira' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Text
                style={{ color: TEXT_SECONDARY, fontSize: 13, display: 'block', marginBottom: 6 }}
              >
                Domain (e.g. yourco.atlassian.net)
              </Text>
              <Input
                placeholder="yourco.atlassian.net"
                value={integrationInputs[`${integration.id}-domain`] || ''}
                onChange={(e) =>
                  setIntegrationInputs((p) => ({
                    ...p,
                    [`${integration.id}-domain`]: e.target.value,
                  }))
                }
                style={{ background: 'rgba(0,0,0,0.3)', borderColor: 'rgba(255,255,255,0.12)' }}
              />
            </div>
            <div>
              <Text
                style={{ color: TEXT_SECONDARY, fontSize: 13, display: 'block', marginBottom: 6 }}
              >
                Email
              </Text>
              <Input
                placeholder="you@yourco.com"
                value={integrationInputs[`${integration.id}-email`] || ''}
                onChange={(e) =>
                  setIntegrationInputs((p) => ({
                    ...p,
                    [`${integration.id}-email`]: e.target.value,
                  }))
                }
                style={{ background: 'rgba(0,0,0,0.3)', borderColor: 'rgba(255,255,255,0.12)' }}
              />
            </div>
            <div>
              <Text
                style={{ color: TEXT_SECONDARY, fontSize: 13, display: 'block', marginBottom: 6 }}
              >
                API token{' '}
                <Typography.Link
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 12, color: PRIMARY }}
                >
                  id.atlassian.com →
                </Typography.Link>
              </Text>
              <Input.Password
                placeholder="ATATT3x…"
                value={inputValue}
                onChange={(e) =>
                  setIntegrationInputs((p) => ({ ...p, [inputKey]: e.target.value }))
                }
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  borderColor: 'rgba(255,255,255,0.12)',
                  fontFamily: 'monospace',
                }}
              />
            </div>
          </div>
        )}

        {integration.id === 'notion' && (
          <div>
            <Text
              style={{ color: TEXT_SECONDARY, fontSize: 13, display: 'block', marginBottom: 8 }}
            >
              Integration token{' '}
              <Typography.Link
                href="https://www.notion.so/my-integrations"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, color: PRIMARY }}
              >
                notion.so/my-integrations →
              </Typography.Link>
            </Text>
            <Input.Password
              placeholder="secret_…"
              value={inputValue}
              onChange={(e) => setIntegrationInputs((p) => ({ ...p, [inputKey]: e.target.value }))}
              style={{
                background: 'rgba(0,0,0,0.3)',
                borderColor: 'rgba(255,255,255,0.12)',
                fontFamily: 'monospace',
              }}
            />
          </div>
        )}

        {/* Sub-panel footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 24,
            paddingTop: 16,
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <Button
            type="text"
            icon={<LeftOutlined />}
            onClick={() => setActiveIntegration(null)}
            style={{ color: TEXT_SECONDARY, paddingLeft: 0 }}
          >
            Back to tools
          </Button>
          <Button
            type="primary"
            disabled={!subPrimaryEnabled}
            onClick={() => {
              // TODO: Wire to real MCP server creation via onCreateMCPServer prop
              setActiveIntegration(null);
            }}
          >
            Connect {integration.name}
          </Button>
        </div>
      </div>
    );
  };

  const renderIntegrations = () => {
    const slackConfig = INTEGRATIONS.find((i) => i.id === 'slack')!;
    const gridIntegrations = INTEGRATIONS.filter((i) => i.id !== 'slack');

    if (activeIntegration) {
      const config = INTEGRATIONS.find((i) => i.id === activeIntegration);
      if (!config) return null;
      return (
        <div>
          <div style={{ marginBottom: 20 }}>
            <Text style={{ color: TEXT_PRIMARY, fontWeight: 600, fontSize: 16 }}>
              {config.emoji} Connect {config.name}
            </Text>
          </div>
          {renderIntegrationSubPanel(config)}
        </div>
      );
    }

    return (
      <div>
        <Title level={3} style={{ color: TEXT_PRIMARY, marginBottom: 8, marginTop: 0 }}>
          Give your AI superpowers.
        </Title>
        <Paragraph style={{ color: TEXT_SECONDARY, marginBottom: 20 }}>
          Connect your tools and your AI can take real action across your entire workflow.
        </Paragraph>

        {/* Slack featured card */}
        <div
          style={{
            background: token.colorPrimaryBg,
            border: `1px solid ${token.colorPrimaryBorder}`,
            borderRadius: token.borderRadiusLG,
            padding: '16px 18px',
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 28 }}>💬</span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <Text style={{ color: TEXT_PRIMARY, fontWeight: 600, fontSize: 14 }}>Slack</Text>
                <Tag
                  color="processing"
                  style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px' }}
                >
                  Recommended
                </Tag>
              </div>
              <Text style={{ color: TEXT_SECONDARY, fontSize: 12 }}>{slackConfig.description}</Text>
            </div>
          </div>
          <Button
            type="primary"
            size="small"
            onClick={() => setActiveIntegration('slack')}
            style={{ flexShrink: 0 }}
          >
            Connect Slack
          </Button>
        </div>

        {/* 2x2 grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            marginBottom: 16,
          }}
        >
          {gridIntegrations.map((integration) => (
            <div
              key={integration.id}
              onMouseEnter={() => setHoveredIntegration(integration.id as IntegrationId)}
              onMouseLeave={() => setHoveredIntegration(null)}
              style={{
                background:
                  hoveredIntegration === integration.id ? 'rgba(255,255,255,0.07)' : GLASS_CARD_BG,
                border:
                  hoveredIntegration === integration.id
                    ? `1px solid ${token.colorPrimaryBorder}`
                    : GLASS_CARD_BORDER,
                borderRadius: 10,
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                transition: 'background 0.15s, border-color 0.15s',
                cursor: 'default',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{integration.emoji}</span>
                  <Text style={{ color: TEXT_PRIMARY, fontWeight: 600, fontSize: 13 }}>
                    {integration.name}
                  </Text>
                </div>
                <Button
                  type="text"
                  size="small"
                  onClick={() => setActiveIntegration(integration.id as IntegrationId)}
                  style={{ color: PRIMARY, padding: '2px 8px', fontSize: 12 }}
                >
                  Connect
                </Button>
              </div>
              <Text style={{ color: TEXT_MUTED, fontSize: 11 }}>{integration.description}</Text>
            </div>
          ))}
        </div>

        <Text style={{ color: TEXT_MUTED, fontSize: 12 }}>
          There are many more integrations available in{' '}
          <span style={{ color: TEXT_SECONDARY }}>Settings → Integrations</span>
        </Text>
      </div>
    );
  };

  const renderDone = () => {
    const aiConnected = hasAnyLlmKey(user) || (selectedAgent !== null && apiKey.length > 8);
    const workspaceReady = hasExistingBoard;
    const integrationsConnected = slackConnected;

    return (
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        {/* Success icon */}
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: 'rgba(16,185,129,0.15)',
            border: '2px solid rgba(16,185,129,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px',
          }}
        >
          <CheckCircleOutlined style={{ color: SUCCESS_GREEN, fontSize: 36 }} />
        </div>

        <Title level={2} style={{ color: TEXT_PRIMARY, marginBottom: 8, marginTop: 0 }}>
          You're ready to build.
        </Title>
        <Paragraph
          style={{ color: TEXT_SECONDARY, marginBottom: 28, maxWidth: 380, margin: '0 auto 28px' }}
        >
          Your board is set up. Start your first AI session — that's where the real work happens.
        </Paragraph>

        {/* Summary checklist */}
        <div
          style={{
            background: GLASS_CARD_BG,
            border: GLASS_CARD_BORDER,
            borderRadius: 10,
            padding: '16px 20px',
            textAlign: 'left',
            marginBottom: 8,
          }}
        >
          {[
            {
              label: 'AI connected',
              done: aiConnected,
              hint: 'Add in Settings → AI & Agents',
            },
            {
              label: 'Workspace ready',
              done: workspaceReady,
              hint: 'Create a board in Settings',
            },
            {
              label: 'Integrations',
              done: integrationsConnected,
              hint: 'Add in Settings → Integrations',
            },
          ].map(({ label, done, hint }) => (
            <div
              key={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 0',
              }}
            >
              <span
                style={{
                  fontSize: 14,
                  color: done ? SUCCESS_GREEN : TEXT_MUTED,
                  fontWeight: 600,
                  width: 16,
                  textAlign: 'center',
                }}
              >
                {done ? '✓' : '·'}
              </span>
              <Text style={{ color: done ? TEXT_PRIMARY : TEXT_SECONDARY, flex: 1, fontSize: 13 }}>
                {label}
              </Text>
              {!done && <Text style={{ color: TEXT_MUTED, fontSize: 11 }}>{hint}</Text>}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ─── Footer ───────────────────────────────────────────────────────────────

  const isPrimaryLoading = llmSaving || boardCreating;
  const effectivePrimaryEnabled = primaryEnabled && !isPrimaryLoading;

  // When in a sub-panel, the sub-panel has its own footer buttons
  const showMainFooter = !(currentStep === 'integrations' && activeIntegration !== null);

  const footer = showMainFooter ? (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 32px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div>
        {canGoBack && (
          <Button
            type="text"
            icon={<LeftOutlined />}
            onClick={handleBack}
            style={{ color: TEXT_SECONDARY, paddingLeft: 0 }}
          >
            Back
          </Button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {isSkippable && (
          <Button
            type="text"
            onClick={handleSkip}
            style={{
              color: TEXT_MUTED,
              textDecoration: 'underline',
              padding: '4px 0',
              fontSize: 13,
            }}
          >
            Skip for now
          </Button>
        )}
        <Button
          type="primary"
          disabled={!effectivePrimaryEnabled}
          onClick={handlePrimary}
          icon={
            isPrimaryLoading ? <Spin indicator={<LoadingOutlined />} size="small" /> : undefined
          }
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  ) : null;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <Modal
      open={open}
      closable={false}
      mask={true}
      keyboard={false}
      footer={null}
      width={600}
      styles={{
        mask: {
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          background: 'rgba(0,0,0,0.6)',
        },
        content: {
          background: MODAL_BG,
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderRadius: 16,
          padding: 0,
          boxShadow:
            '0 32px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.1)',
          overflow: 'hidden',
        },
        body: { padding: 0 },
      }}
    >
      {/* Progress indicator */}
      <div style={{ padding: '24px 32px 0' }}>{renderProgressDots()}</div>

      {/* Step content */}
      <div
        style={{
          padding: '20px 32px',
          height: 440,
          overflowY: 'auto',
        }}
      >
        {currentStep === 'persona' && renderPersona()}
        {currentStep === 'llm' && renderLlm()}
        {currentStep === 'workspace' && renderWorkspace()}
        {currentStep === 'integrations' && renderIntegrations()}
        {currentStep === 'done' && renderDone()}
      </div>

      {/* Footer */}
      {footer}
    </Modal>
  );
}
