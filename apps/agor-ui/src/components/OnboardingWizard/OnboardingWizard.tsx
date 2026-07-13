/**
 * OnboardingWizard - streamlined two-input setup for new users.
 *
 * Flow:
 * 1. AI teammate identity (name + emoji)
 * 2. LLM/provider configuration
 * 3. One progress screen while Agor creates the default AI teammate workspace
 */

import type {
  AgenticToolConfigField,
  AgenticToolName,
  AuthCheckResult,
  Branch,
  CloneRepositoryResult,
  CodexApprovalPolicy,
  CodexSandboxMode,
  CreateLocalRepoRequest,
  CreateRepoRequest,
  DefaultModelConfig,
  PermissionMode,
  Repo,
  TeammateConfig,
  UpdateUserInput,
  User,
  UserPreferences,
} from '@agor-live/client';
import {
  getDefaultPermissionMode,
  mapToCodexPermissionConfig,
  shortId,
  TOOL_API_KEY_NAMES,
} from '@agor-live/client';
import { CheckCircleOutlined, KeyOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Result,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FRAMEWORK_REPO_SLUG,
  FRAMEWORK_REPO_URL,
  findFrameworkRepo,
} from '../../hooks/useFrameworkRepo';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById, selectRepoById } from '../../store/selectors';
import type { CreateRepoOptions } from '../../types';
import { buildAgenticToolCredentialPatch } from '../../utils/agenticToolCredentials';
import { slugify } from '../../utils/repoSlug';
import { startTeammateBootstrapSession } from '../../utils/startTeammateBootstrapSession';
import { buildTeammateBootstrapPrompt } from '../../utils/teammateBootstrapPrompt';
import { ensureTeammateWelcomeNote } from '../../utils/teammateWelcomeNote';
import { ClaudeSubscriptionTokenInstructions } from '../ClaudeSubscriptionTokenInstructions';
import { EmojiPickerInput } from '../EmojiPickerInput/EmojiPickerInput';
import type { NewSessionConfig } from '../NewSessionModal/NewSessionModal';
import { ToolIcon } from '../ToolIcon';

const { Text, Title, Paragraph } = Typography;
const { useToken } = theme;

const CLONE_TIMEOUT_MS = 120_000;

type WizardPath = 'teammate';
type WizardStep = 'identity' | 'llm' | 'loading';
type AuthMethod = 'api-key' | 'claude-subscription-token' | 'codex-cli-auth';
type SetupStage = 'idle' | 'cloning' | 'board' | 'branch' | 'session' | 'done' | 'error';

export interface OnboardingWizardProps {
  open: boolean;
  onComplete: (result: {
    branchId: string;
    sessionId: string;
    boardId: string;
    path: WizardPath;
  }) => void;

  user?: User | null;
  // biome-ignore lint/suspicious/noExplicitAny: AgorClient type varies across package boundaries in tests/apps.
  client: any;

  onCreateRepo: (
    data: CreateRepoRequest,
    options?: CreateRepoOptions
  ) => Promise<CloneRepositoryResult | undefined>;
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
  frameworkRepoUrl?: string;
}

function sanitizeBranchName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function defaultTeammateBranchName(displayName: string): string {
  const slug = slugify(displayName.trim() || 'My Teammate') || 'my-teammate';
  return sanitizeBranchName(`private-${slug}`);
}

function findReadyFrameworkRepo(repoById: Map<string, Repo>): [string, Repo] | undefined {
  return findFrameworkRepo(repoById, { readyOnly: true });
}

function entriesByRepoId(repos: Repo[]): Map<string, Repo> {
  return new Map(repos.map((repo) => [repo.repo_id, repo]));
}

function apiKeyNameForAgent(
  agent: AgenticToolName,
  authMethod: AuthMethod = 'api-key'
): AgenticToolConfigField {
  if (agent === 'claude-code' && authMethod === 'claude-subscription-token') {
    return 'CLAUDE_CODE_OAUTH_TOKEN';
  }
  return TOOL_API_KEY_NAMES[agent] ?? 'ANTHROPIC_API_KEY';
}

function apiKeyPlaceholder(agent: AgenticToolName, authMethod: AuthMethod = 'api-key'): string {
  if (agent === 'claude-code' && authMethod === 'claude-subscription-token')
    return 'sk-ant-oat01-...';
  if (agent === 'codex') return 'sk-...';
  if (agent === 'gemini') return 'AIza...';
  if (agent === 'copilot') return 'ghp_...';
  if (agent === 'cursor') return 'key_...';
  return 'sk-ant-...';
}

const AGENT_LABELS: Record<AgenticToolName, string> = {
  'claude-code': 'Claude Code',
  'claude-code-cli': 'Claude Code CLI',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor SDK',
};

const RECOMMENDED_AGENT_OPTIONS: Array<{ value: AgenticToolName; title: string; eyebrow: string }> =
  [
    { value: 'claude-code', title: 'Claude Code', eyebrow: 'Recommended' },
    { value: 'codex', title: 'Codex', eyebrow: 'Recommended' },
  ];

const OTHER_AGENT_OPTIONS: Array<{ value: AgenticToolName; label: string }> = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'copilot', label: 'GitHub Copilot' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cursor', label: 'Cursor SDK (Beta)' },
];

const RECOMMENDED_AGENT_VALUES = new Set<AgenticToolName>(
  RECOMMENDED_AGENT_OPTIONS.map((option) => option.value)
);

const AGENT_KEY_CONSOLES: Record<AgenticToolName, { label: string; url: string } | null> = {
  'claude-code': {
    label: 'platform.claude.com/settings/keys',
    url: 'https://platform.claude.com/settings/keys',
  },
  'claude-code-cli': {
    label: 'platform.claude.com/settings/keys',
    url: 'https://platform.claude.com/settings/keys',
  },
  codex: { label: 'platform.openai.com/api-keys', url: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'aistudio.google.com', url: 'https://aistudio.google.com/apikey' },
  copilot: { label: 'github.com/features/copilot', url: 'https://github.com/features/copilot' },
  cursor: { label: 'cursor.com', url: 'https://cursor.com' },
  opencode: null,
};

function defaultAuthMethodForAgent(agent: AgenticToolName): AuthMethod {
  if (agent === 'claude-code') return 'claude-subscription-token';
  return agent === 'codex' ? 'codex-cli-auth' : 'api-key';
}

function toSessionModelConfig(
  config?: DefaultModelConfig
): NewSessionConfig['modelConfig'] | undefined {
  if (!config?.model) return undefined;
  return {
    mode: config.mode ?? 'exact',
    model: config.model,
    ...(config.advisorModel ? { advisorModel: config.advisorModel } : {}),
  };
}

function authMethodOptionsForAgent(agent: AgenticToolName) {
  if (agent === 'claude-code') {
    return [
      { value: 'claude-subscription-token' as const, label: 'Subscription' },
      { value: 'api-key' as const, label: 'API key' },
    ];
  }
  if (agent === 'codex') {
    return [
      { value: 'codex-cli-auth' as const, label: 'CLI sign-in' },
      { value: 'api-key' as const, label: 'API key' },
    ];
  }
  return null;
}

export function OnboardingWizard({
  open,
  onComplete,
  user,
  client,
  onCreateRepo,
  onCreateBranch,
  onCreateSession,
  onUpdateUser,
  onCheckAuth,
  frameworkRepoUrl,
}: OnboardingWizardProps) {
  // Self-subscribe to the entity maps this wizard reads. The subscription used
  // to live in the outer App shell; relocating it here keeps the shell from
  // re-rendering on every repo/branch/board write.
  const repoById = useAgorStore(selectRepoById);
  const branchById = useAgorStore(selectBranchById);
  const boardById = useAgorStore(selectBoardById);
  const { token } = useToken();
  const [currentStep, setCurrentStep] = useState<WizardStep>('identity');
  const [teammateDisplayName, setTeammateDisplayName] = useState('My Teammate');
  const [teammateEmoji, setTeammateEmoji] = useState('🤖');
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>('claude-code');
  const [lastRecommendedAgent, setLastRecommendedAgent] = useState<AgenticToolName>('claude-code');
  const [useDifferentProvider, setUseDifferentProvider] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>(() =>
    defaultAuthMethodForAgent('claude-code')
  );
  const [apiKey, setApiKey] = useState('');
  const [overrideDetectedAuth, setOverrideDetectedAuth] = useState(false);
  const [manualTestResult, setManualTestResult] = useState<AuthCheckResult | null>(null);
  const [testAuthLoading, setTestAuthLoading] = useState(false);
  const [setupStage, setSetupStage] = useState<SetupStage>('idle');
  const [operationText, setOperationText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const cloneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clonePollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completingRepoRef = useRef<string | null>(null);
  const knownFailedRepoIdsRef = useRef<Set<string>>(new Set());
  const defaultBranchName = useMemo(
    () => defaultTeammateBranchName(teammateDisplayName),
    [teammateDisplayName]
  );

  const saveOnboardingProgress = useCallback(
    (updates: {
      path?: WizardPath;
      repoId?: string;
      boardId?: string;
      branchId?: string;
      teammateDisplayName?: string;
      teammateEmoji?: string;
    }) => {
      if (!user) return;
      const current = user.preferences?.onboarding || {};
      const prefs: Record<string, unknown> = {
        ...user.preferences,
        onboarding: { ...current, ...updates },
      };
      if (updates.boardId) prefs.mainBoardId = updates.boardId;
      onUpdateUser(user.user_id, { preferences: prefs as UserPreferences });
    },
    [onUpdateUser, user]
  );

  useEffect(() => {
    if (!open || !user) return;
    const onboarding = user.preferences?.onboarding;
    const savedDisplayName = onboarding?.teammateDisplayName ?? onboarding?.assistantDisplayName;
    if (typeof savedDisplayName === 'string') {
      setTeammateDisplayName(savedDisplayName || 'My Teammate');
    }
    const savedEmoji = onboarding?.teammateEmoji ?? onboarding?.assistantEmoji;
    if (typeof savedEmoji === 'string') {
      setTeammateEmoji(savedEmoji || '🤖');
    }
  }, [open, user]);

  useEffect(() => {
    return () => {
      if (cloneTimeoutRef.current) clearTimeout(cloneTimeoutRef.current);
      if (clonePollTimeoutRef.current) clearTimeout(clonePollTimeoutRef.current);
    };
  }, []);

  const hasKeyForAgent = useCallback(
    (agent: AgenticToolName): boolean => {
      const claudeFields = user?.agentic_tools?.['claude-code'];
      const codexFields = user?.agentic_tools?.codex;
      const geminiFields = user?.agentic_tools?.gemini;
      const copilotFields = user?.agentic_tools?.copilot;
      const cursorFields = user?.agentic_tools?.cursor;
      const hasAnthropicKey = !!(
        claudeFields?.ANTHROPIC_API_KEY ||
        claudeFields?.CLAUDE_CODE_OAUTH_TOKEN ||
        user?.env_vars?.ANTHROPIC_API_KEY ||
        user?.env_vars?.CLAUDE_CODE_OAUTH_TOKEN
      );
      const hasOpenAIKey = !!(codexFields?.OPENAI_API_KEY || user?.env_vars?.OPENAI_API_KEY);
      const hasGeminiKey = !!(geminiFields?.GEMINI_API_KEY || user?.env_vars?.GEMINI_API_KEY);
      const hasCopilotToken = !!(
        copilotFields?.COPILOT_GITHUB_TOKEN || user?.env_vars?.COPILOT_GITHUB_TOKEN
      );
      const hasCursorKey = !!(cursorFields?.CURSOR_API_KEY || user?.env_vars?.CURSOR_API_KEY);

      if (agent === 'claude-code') return hasAnthropicKey;
      if (agent === 'codex') return hasOpenAIKey;
      if (agent === 'gemini') return hasGeminiKey;
      if (agent === 'copilot') return hasCopilotToken;
      if (agent === 'cursor') return hasCursorKey;
      if (agent === 'opencode') return hasAnthropicKey || hasOpenAIKey || hasGeminiKey;
      return false;
    },
    [user]
  );

  const resetProviderAuthState = useCallback(() => {
    setApiKey('');
    setError(null);
    setManualTestResult(null);
    setOverrideDetectedAuth(false);
  }, []);

  const selectAgent = useCallback(
    (agent: AgenticToolName, options: { useDifferentProvider?: boolean } = {}) => {
      setSelectedAgent(agent);
      setAuthMethod(defaultAuthMethodForAgent(agent));
      if (RECOMMENDED_AGENT_VALUES.has(agent)) setLastRecommendedAgent(agent);
      setUseDifferentProvider(options.useDifferentProvider ?? !RECOMMENDED_AGENT_VALUES.has(agent));
      resetProviderAuthState();
    },
    [resetProviderAuthState]
  );

  const buildSessionConfig = useCallback(
    (branchId: string): NewSessionConfig => {
      const agentDefaults = user?.default_agentic_config?.[selectedAgent];
      const permissionMode: PermissionMode =
        agentDefaults?.permissionMode ?? getDefaultPermissionMode(selectedAgent);
      const sessionConfig: NewSessionConfig = {
        branch_id: branchId,
        agent: selectedAgent,
        initialPrompt: buildTeammateBootstrapPrompt({
          displayName: teammateDisplayName.trim() || 'My Teammate',
          emoji: teammateEmoji || '🤖',
          userName: user?.name,
          userEmail: user?.email,
        }),
        modelConfig: toSessionModelConfig(agentDefaults?.modelConfig),
        effort: agentDefaults?.modelConfig?.effort,
        mcpServerIds: user?.default_mcp_server_ids,
        permissionMode,
      };

      if (selectedAgent === 'codex') {
        const codexDefaults = mapToCodexPermissionConfig(permissionMode);
        sessionConfig.codexSandboxMode =
          (agentDefaults?.codexSandboxMode as CodexSandboxMode | undefined) ??
          codexDefaults.sandboxMode;
        sessionConfig.codexApprovalPolicy =
          (agentDefaults?.codexApprovalPolicy as CodexApprovalPolicy | undefined) ??
          codexDefaults.approvalPolicy;
        sessionConfig.codexNetworkAccess =
          agentDefaults?.codexNetworkAccess ?? codexDefaults.networkAccess;
      }

      return sessionConfig;
    },
    [teammateDisplayName, teammateEmoji, selectedAgent, user]
  );

  const branches = useMemo(() => Array.from(branchById.values()), [branchById]);

  const findExistingTeammateBranch = useCallback(
    async (repoId: string, branchName: string): Promise<Branch | null> => {
      for (const branch of branches) {
        if (
          branch.repo_id === repoId &&
          branch.name === branchName &&
          !branch.archived &&
          branch.filesystem_status !== 'failed'
        ) {
          return branch;
        }
      }

      try {
        const result = await client?.service('branches').find({
          query: {
            repo_id: repoId,
            name: branchName,
            archived: false,
            filesystem_status: { $ne: 'failed' },
            $limit: 1,
          },
        });
        const branches = Array.isArray(result) ? result : (result?.data ?? []);
        return (branches[0] as Branch | undefined) ?? null;
      } catch {
        return null;
      }
    },
    [branches, client]
  );

  const findExistingTeammateSession = useCallback(
    async (branchId: string): Promise<string | null> => {
      try {
        const result = await client?.service('sessions').find({
          query: { branch_id: branchId, archived: false, $limit: 1, $sort: { created_at: -1 } },
        });
        const sessions = Array.isArray(result) ? result : (result?.data ?? []);
        const sessionId = sessions[0]?.session_id;
        return typeof sessionId === 'string' ? sessionId : null;
      } catch {
        return null;
      }
    },
    [client]
  );

  const fetchExistingFrameworkRepo = useCallback(async (): Promise<Repo | null> => {
    try {
      const exactResult = await client?.service('repos').find({
        query: { slug: FRAMEWORK_REPO_SLUG, $limit: 1 },
      });
      const exactRepos = Array.isArray(exactResult) ? exactResult : (exactResult?.data ?? []);
      const exactMatch = findFrameworkRepo(entriesByRepoId(exactRepos), { excludeFailed: true });
      if (exactMatch) return exactMatch[1];

      const fallbackResult = await client?.service('repos').find({ query: { $limit: 50 } });
      const fallbackRepos = Array.isArray(fallbackResult)
        ? fallbackResult
        : (fallbackResult?.data ?? []);
      return (
        findFrameworkRepo(entriesByRepoId(fallbackRepos), { excludeFailed: true })?.[1] ?? null
      );
    } catch {
      return null;
    }
  }, [client]);

  const finishSetupFromRepo = useCallback(
    async (repoId: string, repoOverride?: Repo) => {
      if (completingRepoRef.current === repoId) return;
      completingRepoRef.current = repoId;
      if (cloneTimeoutRef.current) {
        clearTimeout(cloneTimeoutRef.current);
        cloneTimeoutRef.current = null;
      }
      if (clonePollTimeoutRef.current) {
        clearTimeout(clonePollTimeoutRef.current);
        clonePollTimeoutRef.current = null;
      }

      try {
        setError(null);
        saveOnboardingProgress({ repoId });

        setSetupStage('board');
        setOperationText('Creating your AI teammate board…');
        const existingBoardId = user?.preferences?.mainBoardId;
        let boardId =
          existingBoardId && user && boardById.get(existingBoardId)?.created_by === user.user_id
            ? existingBoardId
            : null;

        if (!boardId) {
          const board = await client?.service('boards').create({
            name: `${teammateDisplayName.trim() || 'My Teammate'}'s Board`,
            icon: teammateEmoji || '🤖',
          });
          boardId = board?.board_id ?? null;
        }
        if (!boardId) throw new Error('Failed to create AI teammate board.');
        saveOnboardingProgress({ boardId });
        await ensureTeammateWelcomeNote({
          client,
          boardId,
          teammateName: teammateDisplayName.trim() || 'My Teammate',
          teammateEmoji,
        });

        setSetupStage('branch');
        setOperationText('Creating the default AI teammate branch…');
        const sourceBranch =
          repoOverride?.default_branch || repoById.get(repoId)?.default_branch || 'main';
        const teammateConfig: TeammateConfig = {
          kind: 'teammate',
          displayName: teammateDisplayName.trim() || 'My Teammate',
          emoji: teammateEmoji || undefined,
          frameworkRepo: FRAMEWORK_REPO_SLUG,
          createdViaOnboarding: true,
        };
        const fallbackBranchSuffix = user?.user_id
          ? shortId(user.user_id)
          : Date.now().toString(36).slice(-6);
        const uniqueDefaultBranchName = sanitizeBranchName(
          `${defaultBranchName}-${fallbackBranchSuffix}`
        );
        const branchNameCandidates = [uniqueDefaultBranchName, defaultBranchName];
        let branch: Branch | null = null;
        let existingBranch: Branch | null = null;
        let lastCreateError: unknown;

        for (const branchName of branchNameCandidates) {
          existingBranch = await findExistingTeammateBranch(repoId, branchName);
          if (existingBranch) {
            branch = existingBranch;
            break;
          }

          try {
            branch = await onCreateBranch(repoId, {
              name: branchName,
              ref: branchName,
              createBranch: true,
              sourceBranch,
              pullLatest: true,
              boardId,
              custom_context: { teammate: teammateConfig },
            });
            if (branch?.branch_id) break;
          } catch (err) {
            lastCreateError = err;
            const message = err instanceof Error ? err.message : String(err);
            if (
              !message.includes('already exists') &&
              !message.includes('in use by another branch')
            ) {
              throw err;
            }
          }
        }

        if (!branch?.branch_id) {
          if (lastCreateError instanceof Error) throw lastCreateError;
          throw new Error('Failed to create AI teammate branch.');
        }
        if (existingBranch?.board_id && existingBranch.board_id !== boardId) {
          boardId = existingBranch.board_id;
          saveOnboardingProgress({ boardId });
        }
        saveOnboardingProgress({ branchId: branch.branch_id });
        await client?.service('boards').setPrimaryTeammate({ boardId, branchId: branch.branch_id });

        setSetupStage('session');
        setOperationText('Starting your AI teammate…');
        const existingSessionId = await findExistingTeammateSession(branch.branch_id);
        const sessionId =
          existingSessionId ??
          (await startTeammateBootstrapSession({
            client,
            branchId: branch.branch_id,
            boardId,
            sessionConfig: buildSessionConfig(branch.branch_id),
            onCreateSession,
            onStatusChange: setOperationText,
          }));

        setSetupStage('done');
        setOperationText('Opening your AI teammate…');
        onComplete({ branchId: branch.branch_id, sessionId, boardId, path: 'teammate' });
      } catch (err) {
        completingRepoRef.current = null;
        setSetupStage('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      teammateDisplayName,
      teammateEmoji,
      boardById,
      buildSessionConfig,
      client,
      defaultBranchName,
      findExistingTeammateBranch,
      findExistingTeammateSession,
      onComplete,
      onCreateBranch,
      onCreateSession,
      repoById,
      saveOnboardingProgress,
      user,
    ]
  );

  const pollRepoUntilReady = useCallback(
    (repoId: string) => {
      const poll = async () => {
        if (completingRepoRef.current === repoId) return;
        try {
          const repo = (await client?.service('repos').get(repoId)) as Repo | undefined;
          if (!repo) return;
          if (repo.clone_status === 'failed') {
            setSetupStage('error');
            setError(
              repo.clone_error?.message ??
                `Clone failed (exit ${repo.clone_error?.exit_code ?? '?'}).`
            );
            if (cloneTimeoutRef.current) {
              clearTimeout(cloneTimeoutRef.current);
              cloneTimeoutRef.current = null;
            }
            return;
          }
          if (repo.clone_status === 'ready' || repo.clone_status === undefined) {
            await finishSetupFromRepo(repo.repo_id, repo);
            return;
          }
        } catch {
          // Keep polling until the existing clone timeout surfaces a user-facing error.
        }

        clonePollTimeoutRef.current = setTimeout(poll, 1000);
      };

      if (clonePollTimeoutRef.current) clearTimeout(clonePollTimeoutRef.current);
      clonePollTimeoutRef.current = setTimeout(poll, 0);
    },
    [client, finishSetupFromRepo]
  );

  const startSetup = useCallback(async () => {
    setCurrentStep('loading');
    setSetupStage('cloning');
    setOperationText('Cloning AI teammate framework…');
    setError(null);
    completingRepoRef.current = null;

    const readyRepo = findReadyFrameworkRepo(repoById);
    if (readyRepo) {
      setOperationText('Preparing AI teammate workspace…');
      void finishSetupFromRepo(readyRepo[0], readyRepo[1]);
      return;
    }

    knownFailedRepoIdsRef.current = new Set(
      Array.from(repoById.values())
        .filter((repo) => repo.clone_status === 'failed')
        .map((repo) => repo.repo_id)
    );

    const startCloneTimeout = () => {
      if (cloneTimeoutRef.current) clearTimeout(cloneTimeoutRef.current);
      cloneTimeoutRef.current = setTimeout(() => {
        setSetupStage('error');
        setError(
          'Clone is taking longer than expected. Please check the repository connection and try again.'
        );
      }, CLONE_TIMEOUT_MS);
    };

    try {
      const cloneResult = await onCreateRepo(
        {
          url: frameworkRepoUrl || FRAMEWORK_REPO_URL,
          slug: FRAMEWORK_REPO_SLUG,
          default_branch: 'main',
        },
        { silent: true }
      );

      if (cloneResult?.status === 'exists') {
        setOperationText('Preparing AI teammate workspace…');
      }

      if (cloneResult?.repo_id) {
        pollRepoUntilReady(cloneResult.repo_id);
        startCloneTimeout();
        return;
      }

      const existingRepo = await fetchExistingFrameworkRepo();
      if (existingRepo?.repo_id) {
        if (existingRepo.clone_status === 'cloning') {
          pollRepoUntilReady(existingRepo.repo_id);
          startCloneTimeout();
        } else {
          setOperationText('Preparing AI teammate workspace…');
          void finishSetupFromRepo(existingRepo.repo_id, existingRepo);
        }
        return;
      }

      startCloneTimeout();
    } catch (err) {
      const existingRepo = await fetchExistingFrameworkRepo();
      if (existingRepo?.repo_id) {
        setOperationText('Preparing AI teammate workspace…');
        if (existingRepo.clone_status === 'cloning') {
          pollRepoUntilReady(existingRepo.repo_id);
          startCloneTimeout();
        } else {
          void finishSetupFromRepo(existingRepo.repo_id, existingRepo);
        }
        return;
      }
      setSetupStage('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    fetchExistingFrameworkRepo,
    finishSetupFromRepo,
    frameworkRepoUrl,
    onCreateRepo,
    pollRepoUntilReady,
    repoById,
  ]);

  useEffect(() => {
    if (currentStep !== 'loading' || setupStage !== 'cloning') return;
    const readyRepo = findReadyFrameworkRepo(repoById);
    if (readyRepo) void finishSetupFromRepo(readyRepo[0], readyRepo[1]);
  }, [currentStep, finishSetupFromRepo, repoById, setupStage]);

  useEffect(() => {
    if (currentStep !== 'loading' || setupStage !== 'cloning') return;
    for (const repo of repoById.values()) {
      if (repo.clone_status !== 'failed') continue;
      if (knownFailedRepoIdsRef.current.has(repo.repo_id)) continue;
      const isFrameworkRepo =
        repo.slug === FRAMEWORK_REPO_SLUG ||
        repo.slug === 'preset-io/agor-assistant' ||
        repo.remote_url?.includes('agor-teammate') ||
        repo.remote_url?.includes('agor-assistant');
      if (!isFrameworkRepo) continue;
      setSetupStage('error');
      setError(
        repo.clone_error?.message ?? `Clone failed (exit ${repo.clone_error?.exit_code ?? '?'}).`
      );
      if (cloneTimeoutRef.current) {
        clearTimeout(cloneTimeoutRef.current);
        cloneTimeoutRef.current = null;
      }
      return;
    }
  }, [currentStep, repoById, setupStage]);

  useEffect(() => {
    if (!client?.io) return;
    const handleCloneError = (data: { slug?: string; url?: string; error: string }) => {
      if (currentStep !== 'loading' || setupStage !== 'cloning') return;
      const isFrameworkRepo =
        data.slug === FRAMEWORK_REPO_SLUG ||
        data.slug === 'preset-io/agor-assistant' ||
        data.url?.includes('agor-teammate') ||
        data.url?.includes('agor-assistant');
      if (!isFrameworkRepo) return;
      setSetupStage('error');
      setError(data.error);
      if (cloneTimeoutRef.current) {
        clearTimeout(cloneTimeoutRef.current);
        cloneTimeoutRef.current = null;
      }
    };
    client.io.on('repo:cloneError', handleCloneError);
    return () => client.io.off('repo:cloneError', handleCloneError);
  }, [client, currentStep, setupStage]);

  const handleTeammateIdentityContinue = useCallback(() => {
    const trimmedName = teammateDisplayName.trim() || 'My Teammate';
    setTeammateDisplayName(trimmedName);
    saveOnboardingProgress({
      path: 'teammate',
      teammateDisplayName: trimmedName,
      teammateEmoji: teammateEmoji || '🤖',
    });
    setError(null);
    setCurrentStep('llm');
  }, [teammateDisplayName, teammateEmoji, saveOnboardingProgress]);

  const handleSaveApiKey = useCallback(async () => {
    if (!user || !apiKey.trim()) return;
    setError(null);
    const keyName = apiKeyNameForAgent(selectedAgent, authMethod);
    const targetTool: AgenticToolName =
      selectedAgent === 'opencode' ? 'claude-code' : selectedAgent;
    try {
      await onUpdateUser(
        user.user_id,
        buildAgenticToolCredentialPatch(targetTool, keyName, apiKey.trim())
      );
      await startSetup();
    } catch (err) {
      setError(`Failed to save API key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [apiKey, authMethod, onUpdateUser, selectedAgent, startSetup, user]);

  const handleTestAuth = useCallback(async () => {
    if (!onCheckAuth) return;
    setTestAuthLoading(true);
    setManualTestResult(null);
    const result = await onCheckAuth(
      selectedAgent,
      authMethod === 'codex-cli-auth' ? undefined : apiKey.trim() || undefined
    );
    setTestAuthLoading(false);
    setManualTestResult(result);
  }, [apiKey, authMethod, onCheckAuth, selectedAgent]);

  const handleSkip = useCallback(() => {
    if (!user) return;
    onComplete({ branchId: '', sessionId: '', boardId: '', path: 'teammate' });
  }, [onComplete, user]);

  const renderIdentity = () => (
    <div>
      <Title level={4} style={{ marginBottom: 8 }}>
        Welcome to Agor ✨
      </Title>
      <Paragraph style={{ marginBottom: 14 }}>
        Start by creating your{' '}
        <Typography.Link
          strong
          href="https://agor.live/guide/teammates"
          target="_blank"
          rel="noopener noreferrer"
        >
          Agor AI teammate
        </Typography.Link>
        : a persistent agent that can help set up your workspace and keep things moving.
      </Paragraph>

      <div
        style={{
          background: token.colorPrimaryBg,
          border: `1px solid ${token.colorPrimaryBorder}`,
          borderRadius: 8,
          padding: '12px 14px',
          marginBottom: 16,
        }}
      >
        <Text strong>Your AI teammate can help:</Text>
        <ul style={{ margin: '8px 0 0', paddingLeft: 20, color: token.colorTextSecondary }}>
          <li>🧰 Connect tools and credentials</li>
          <li>🗺️ Set up your board and workflow</li>
          <li>🤝 Coordinate agents and sessions</li>
          <li>💬 Show you around and answer questions</li>
        </ul>
      </div>

      <Form layout="vertical">
        <Form.Item label="Name and emoji" required>
          <Space.Compact style={{ display: 'flex' }}>
            <EmojiPickerInput value={teammateEmoji} onChange={setTeammateEmoji} defaultEmoji="🤖" />
            <Input
              placeholder="My Teammate"
              value={teammateDisplayName}
              onChange={(event) => setTeammateDisplayName(event.target.value)}
              autoFocus
              style={{ flex: 1 }}
            />
          </Space.Compact>
        </Form.Item>
      </Form>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      <Button
        type="primary"
        onClick={handleTeammateIdentityContinue}
        disabled={!teammateDisplayName.trim()}
      >
        Continue
      </Button>
    </div>
  );

  const renderAuthHint = () => {
    if (selectedAgent === 'claude-code') {
      if (authMethod === 'claude-subscription-token') {
        return (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16, textAlign: 'left' }}
            description={<ClaudeSubscriptionTokenInstructions />}
          />
        );
      }
      return (
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Paste an <Text code>ANTHROPIC_API_KEY</Text> from{' '}
          <Typography.Link href="https://platform.claude.com/settings/keys" target="_blank">
            Claude Console
          </Typography.Link>
          .
        </Paragraph>
      );
    }

    if (selectedAgent === 'codex') {
      if (authMethod === 'codex-cli-auth') {
        return (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16, textAlign: 'left' }}
            description={
              <span>
                Run <Text code>codex login --device-auth</Text>; Agor will use that local auth.
              </span>
            }
          />
        );
      }
      return (
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Paste an <Text code>OPENAI_API_KEY</Text> from{' '}
          <Typography.Link href="https://platform.openai.com/api-keys" target="_blank">
            OpenAI Platform
          </Typography.Link>
          .
        </Paragraph>
      );
    }

    const consoleInfo = AGENT_KEY_CONSOLES[selectedAgent];
    if (!consoleInfo) return null;
    return (
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Paste your {apiKeyNameForAgent(selectedAgent, authMethod)} from{' '}
        <Typography.Link href={consoleInfo.url} target="_blank" rel="noopener noreferrer">
          {consoleInfo.label}
        </Typography.Link>
        .
      </Paragraph>
    );
  };

  const renderLlm = () => {
    const hasKey = hasKeyForAgent(selectedAgent);
    const isAuthenticated = hasKey && !overrideDetectedAuth;
    const authMethodOptions = authMethodOptionsForAgent(selectedAgent);
    const usesCodexCliAuth = selectedAgent === 'codex' && authMethod === 'codex-cli-auth';
    const currentKeyName = apiKeyNameForAgent(selectedAgent, authMethod);

    return (
      <div>
        <Title level={4}>Choose your LLM</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Pick what powers your AI teammate.
        </Paragraph>

        <Space orientation="vertical" size="middle" style={{ width: '100%', marginBottom: 16 }}>
          <div
            role="radiogroup"
            aria-label="Recommended LLM providers"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}
          >
            {RECOMMENDED_AGENT_OPTIONS.map((option) => {
              const selected = selectedAgent === option.value;
              return (
                <Card
                  key={option.value}
                  size="small"
                  style={{
                    borderColor: selected ? token.colorPrimary : token.colorBorder,
                    background: selected ? token.colorPrimaryBg : undefined,
                  }}
                  styles={{ body: { padding: 0 } }}
                >
                  <label style={{ display: 'block', cursor: 'pointer', padding: 14 }}>
                    <Space align="center" size={10} style={{ width: '100%' }}>
                      <ToolIcon tool={option.value} size={32} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text strong>{option.title}</Text>
                        <div>
                          <Tag color={selected ? 'blue' : 'default'}>{option.eyebrow}</Tag>
                        </div>
                      </div>
                      <input
                        type="radio"
                        name="recommended-agent"
                        value={option.value}
                        checked={selected}
                        onChange={() => selectAgent(option.value, { useDifferentProvider: false })}
                        style={{ accentColor: token.colorPrimary }}
                      />
                    </Space>
                  </label>
                </Card>
              );
            })}
          </div>

          <Checkbox
            checked={useDifferentProvider}
            onChange={(event) => {
              const checked = event.target.checked;
              selectAgent(checked ? OTHER_AGENT_OPTIONS[0].value : lastRecommendedAgent, {
                useDifferentProvider: checked,
              });
            }}
          >
            Use a different provider
          </Checkbox>

          {useDifferentProvider && (
            <Form layout="vertical">
              <Form.Item label="Other LLM providers" style={{ marginBottom: 0 }}>
                <Select
                  value={RECOMMENDED_AGENT_VALUES.has(selectedAgent) ? undefined : selectedAgent}
                  onChange={(value) => selectAgent(value, { useDifferentProvider: true })}
                  options={OTHER_AGENT_OPTIONS}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Form>
          )}
        </Space>

        {isAuthenticated ? (
          <div style={{ textAlign: 'center' }}>
            <Result
              style={{ padding: '8px 0 12px' }}
              icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
              title={`${AGENT_LABELS[selectedAgent]} is configured`}
              subTitle={`You're all set to use ${AGENT_LABELS[selectedAgent]}.`}
            />
            <Space orientation="vertical" size="small">
              <Button type="primary" onClick={startSetup}>
                Continue
              </Button>
              <Button type="link" onClick={() => setOverrideDetectedAuth(true)}>
                Use a different API key instead
              </Button>
            </Space>
          </div>
        ) : (
          <>
            {overrideDetectedAuth && (
              <Button
                type="link"
                onClick={() => {
                  setOverrideDetectedAuth(false);
                  setApiKey('');
                }}
                style={{ padding: 0, marginBottom: 12 }}
              >
                ← Back to detected authentication
              </Button>
            )}

            {authMethodOptions && (
              <Radio.Group
                value={authMethod}
                onChange={(event) => {
                  setAuthMethod(event.target.value);
                  setApiKey('');
                  setManualTestResult(null);
                }}
                style={{ width: '100%', marginBottom: 16 }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 8,
                  }}
                >
                  {authMethodOptions.map((option) => (
                    <Radio
                      key={option.value}
                      value={option.value}
                      style={{
                        border: `1px solid ${token.colorBorder}`,
                        borderRadius: 8,
                        marginInlineEnd: 0,
                        padding: '8px 12px',
                      }}
                    >
                      <Text strong={authMethod === option.value}>{option.label}</Text>
                    </Radio>
                  ))}
                </div>
              </Radio.Group>
            )}

            {renderAuthHint()}

            {selectedAgent === 'opencode' && (
              <Paragraph type="secondary" style={{ marginBottom: 16 }}>
                OpenCode supports many LLM providers. Configure the key for your provider below.
              </Paragraph>
            )}

            {!usesCodexCliAuth && (
              <Form layout="vertical">
                <Form.Item label={currentKeyName}>
                  <Input.Password
                    placeholder={apiKeyPlaceholder(selectedAgent, authMethod)}
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setManualTestResult(null);
                    }}
                  />
                </Form.Item>
              </Form>
            )}

            {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
            {manualTestResult && (
              <Alert
                type={
                  manualTestResult.status === 'authenticated'
                    ? 'success'
                    : manualTestResult.status === 'unknown'
                      ? 'info'
                      : 'warning'
                }
                showIcon
                style={{ marginBottom: 16, textAlign: 'left' }}
                message={
                  manualTestResult.status === 'authenticated'
                    ? 'Connection works'
                    : manualTestResult.status === 'unknown'
                      ? "Couldn't verify"
                      : 'Not authenticated'
                }
                description={manualTestResult.hint}
              />
            )}

            <Space wrap>
              {usesCodexCliAuth ? (
                <Button type="primary" onClick={startSetup}>
                  Continue with Codex CLI auth
                </Button>
              ) : (
                <Button
                  type="primary"
                  onClick={handleSaveApiKey}
                  disabled={!apiKey.trim()}
                  icon={<KeyOutlined />}
                >
                  Save & Continue
                </Button>
              )}
              {onCheckAuth && (
                <Button onClick={handleTestAuth} loading={testAuthLoading}>
                  Test Connection
                </Button>
              )}
              {!usesCodexCliAuth && <Button onClick={startSetup}>Continue without key</Button>}
            </Space>
          </>
        )}
      </div>
    );
  };

  const renderLoading = () => (
    <div style={{ textAlign: 'center', padding: '48px 0' }}>
      {setupStage === 'error' ? (
        <>
          <Alert
            type="error"
            message="Setup failed"
            description={error}
            showIcon
            style={{ marginBottom: 16, textAlign: 'left' }}
          />
          <Button type="primary" onClick={startSetup}>
            Retry
          </Button>
        </>
      ) : (
        <>
          <Spin size="large" />
          <Title level={4} style={{ marginTop: 20, marginBottom: 8 }}>
            Setting up Agor
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {operationText}
          </Paragraph>
        </>
      )}
    </div>
  );

  const footer =
    currentStep === 'loading' ? null : (
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          width: '100%',
          textAlign: 'left',
        }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          Step {currentStep === 'identity' ? '1' : '2'} of 2
        </Text>
        <Space size="small">
          {currentStep === 'llm' && (
            <Button type="link" onClick={() => setCurrentStep('identity')}>
              ← Back
            </Button>
          )}
          <Popconfirm
            title="Skip setup?"
            description={
              <div style={{ maxWidth: 250 }}>
                Are you sure? Your AI teammate has been waiting their whole life to meet you.
                <br />
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  (You can always come back via Settings)
                </Text>
              </div>
            }
            okText="Skip anyway"
            cancelText="Go back"
            onConfirm={handleSkip}
          >
            <Button type="text" size="small" style={{ color: token.colorTextTertiary }}>
              Skip setup
            </Button>
          </Popconfirm>
        </Space>
      </div>
    );

  return (
    <Modal
      open={open}
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      footer={footer}
      width={680}
      styles={{
        body: {
          minHeight: 440,
          maxHeight: 640,
          overflowY: 'auto',
          padding: '28px 36px',
        },
      }}
    >
      {currentStep === 'identity' && renderIdentity()}
      {currentStep === 'llm' && renderLlm()}
      {currentStep === 'loading' && renderLoading()}
    </Modal>
  );
}
