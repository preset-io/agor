/**
 * OnboardingWizard - Multi-step wizard for new user onboarding
 *
 * Two paths:
 * - Persisted Agent: Clone agor-openclaw repo -> create board -> create worktree -> API keys -> launch
 * - Own Repo: Add user repo -> create board -> create worktree -> API keys -> launch
 *
 * Replaces GettingStartedPopover entirely.
 */

import type {
  AgenticToolName,
  Board,
  PersistedAgentConfig,
  Repo,
  UpdateUserInput,
  User,
  UserPreferences,
  Worktree,
} from '@agor/core/types';
import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  RocketOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Spin,
  Steps,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NewSessionConfig } from '../NewSessionModal/NewSessionModal';

const { Text, Title, Paragraph } = Typography;
const { useToken } = theme;

// ─── Constants ──────────────────────────────────────────

const OPENCLAW_REPO_URL = 'https://github.com/mistercrunch/agor-openclaw.git';
const OPENCLAW_REPO_SLUG = 'mistercrunch/agor-openclaw';
const CLONE_TIMEOUT_MS = 120_000;

// ─── Types ──────────────────────────────────────────────

type WizardPath = 'persisted-agent' | 'own-repo';

type WizardStep = 'welcome' | 'add-repo' | 'clone' | 'board' | 'worktree' | 'api-keys' | 'launch';

export interface OnboardingWizardProps {
  open: boolean;
  onComplete: (result: {
    worktreeId: string;
    sessionId: string;
    boardId: string;
    path: WizardPath;
  }) => void;

  // Data
  repoById: Map<string, Repo>;
  worktreeById: Map<string, Worktree>;
  boardById: Map<string, Board>;
  user?: User | null;
  // biome-ignore lint/suspicious/noExplicitAny: AgorClient type varies
  client: any;

  // Actions
  onCreateRepo: (data: { url: string; slug: string; default_branch: string }) => void;
  onCreateLocalRepo: (data: { path: string; slug?: string }) => void;
  onCreateWorktree: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      refType?: 'branch' | 'tag';
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      boardId?: string;
      position?: { x: number; y: number };
    }
  ) => Promise<Worktree | null>;
  onCreateSession: (config: NewSessionConfig, boardId: string) => Promise<string | null>;
  onUpdateUser: (userId: string, updates: UpdateUserInput) => void;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => void;

  // Config from health endpoint
  persistedAgentPending?: boolean;
  frameworkRepoUrl?: string;
  systemCredentials?: {
    ANTHROPIC_API_KEY?: boolean;
    OPENAI_API_KEY?: boolean;
    GEMINI_API_KEY?: boolean;
  };
}

// ─── Helpers ────────────────────────────────────────────

function sanitizeBranchName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function getUsernameSlug(user?: User | null): string {
  if (!user) return 'user';
  const name = user.name || user.email.split('@')[0] || 'user';
  return sanitizeBranchName(name);
}

function getStepsForPath(path: WizardPath | null): WizardStep[] {
  if (path === 'persisted-agent') {
    return ['welcome', 'clone', 'board', 'worktree', 'api-keys', 'launch'];
  }
  if (path === 'own-repo') {
    return ['welcome', 'add-repo', 'clone', 'board', 'worktree', 'api-keys', 'launch'];
  }
  return ['welcome'];
}

function getStepIndex(steps: WizardStep[], step: WizardStep): number {
  return steps.indexOf(step);
}

function apiKeyNameForAgent(agent: AgenticToolName): string {
  switch (agent) {
    case 'claude-code':
      return 'ANTHROPIC_API_KEY';
    case 'codex':
      return 'OPENAI_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'opencode':
      return 'ANTHROPIC_API_KEY';
    default:
      return 'ANTHROPIC_API_KEY';
  }
}

function apiKeyPlaceholder(agent: AgenticToolName): string {
  switch (agent) {
    case 'claude-code':
      return 'sk-ant-...';
    case 'codex':
      return 'sk-...';
    case 'gemini':
      return 'AIza...';
    default:
      return 'sk-ant-...';
  }
}

const AGENT_LABELS: Record<AgenticToolName, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex (OpenAI)',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

const AGENT_KEY_CONSOLES: Record<AgenticToolName, { label: string; url: string } | null> = {
  'claude-code': { label: 'console.anthropic.com', url: 'https://console.anthropic.com/' },
  codex: { label: 'platform.openai.com', url: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'aistudio.google.com', url: 'https://aistudio.google.com/apikey' },
  opencode: null,
};

// ─── Component ──────────────────────────────────────────

export function OnboardingWizard({
  open,
  onComplete,
  repoById,
  worktreeById,
  boardById,
  user,
  client,
  onCreateRepo,
  onCreateLocalRepo,
  onCreateWorktree,
  onCreateSession,
  onUpdateUser,
  onUpdateWorktree,
  persistedAgentPending,
  frameworkRepoUrl,
  systemCredentials,
}: OnboardingWizardProps) {
  const { token } = useToken();

  // ─── State ────────────────────────────────────────
  const [path, setPath] = useState<WizardPath | null>(null);
  const [currentStep, setCurrentStep] = useState<WizardStep>('welcome');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Step-specific state
  const [repoUrl, setRepoUrl] = useState('');
  const [repoSlug, setRepoSlug] = useState('');
  const [localRepoPath, setLocalRepoPath] = useState('');
  const [repoMode, setRepoMode] = useState<'remote' | 'local'>('remote');
  const [branchName, setBranchName] = useState('');
  const [worktreeName, setWorktreeName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>('claude-code');

  // Created resource IDs
  const [createdRepoId, setCreatedRepoId] = useState<string | null>(null);
  const [createdBoardId, setCreatedBoardId] = useState<string | null>(null);
  const [createdWorktreeId, setCreatedWorktreeId] = useState<string | null>(null);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);

  // Timeout ref for clone
  const cloneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Derived ──────────────────────────────────────
  const steps = useMemo(() => getStepsForPath(path), [path]);
  const stepIndex = getStepIndex(steps, currentStep);
  const usernameSlug = getUsernameSlug(user);
  const effectiveOpenclawUrl = frameworkRepoUrl || OPENCLAW_REPO_URL;

  const hasAnthropicKey = !!(
    user?.api_keys?.ANTHROPIC_API_KEY ||
    user?.env_vars?.ANTHROPIC_API_KEY ||
    systemCredentials?.ANTHROPIC_API_KEY
  );
  const hasOpenAIKey = !!(
    user?.api_keys?.OPENAI_API_KEY ||
    user?.env_vars?.OPENAI_API_KEY ||
    systemCredentials?.OPENAI_API_KEY
  );
  const hasGeminiKey = !!(
    user?.api_keys?.GEMINI_API_KEY ||
    user?.env_vars?.GEMINI_API_KEY ||
    systemCredentials?.GEMINI_API_KEY
  );

  const hasKeyForAgent = (agent: AgenticToolName): boolean => {
    switch (agent) {
      case 'claude-code':
        return hasAnthropicKey;
      case 'codex':
        return hasOpenAIKey;
      case 'gemini':
        return hasGeminiKey;
      case 'opencode':
        return hasAnthropicKey || hasOpenAIKey || hasGeminiKey;
      default:
        return false;
    }
  };

  // ─── Resume from prior onboarding state ──────────
  const resumedRef = useRef(false);
  useEffect(() => {
    if (!open || resumedRef.current || !user) return;

    const onboarding = user.preferences?.onboarding;
    const mainBoardId = user.preferences?.mainBoardId;

    if (!onboarding?.path) {
      // No prior state — check if CLI set the persisted agent flag
      if (persistedAgentPending && !path) {
        setPath('persisted-agent');
      }
      return;
    }

    // We have prior onboarding state — resume from where user left off
    resumedRef.current = true;
    setPath(onboarding.path);

    // Restore created resource IDs
    if (mainBoardId) {
      setCreatedBoardId(mainBoardId);
    } else if (onboarding.boardId) {
      setCreatedBoardId(onboarding.boardId);
    }

    if (onboarding.worktreeId) {
      setCreatedWorktreeId(onboarding.worktreeId);
    }

    // Figure out which step to resume from
    if (onboarding.worktreeId && worktreeById.has(onboarding.worktreeId)) {
      // Worktree exists — go to API keys
      setCurrentStep('api-keys');
    } else if (mainBoardId && boardById.has(mainBoardId)) {
      // Board exists — go to worktree creation
      setCurrentStep('worktree');
    } else if (onboarding.path === 'persisted-agent') {
      // Check if the openclaw repo already exists
      let foundRepo = false;
      for (const [id, repo] of repoById) {
        if (repo.slug === OPENCLAW_REPO_SLUG || repo.remote_url?.includes('agor-openclaw')) {
          setCreatedRepoId(id);
          foundRepo = true;
          break;
        }
      }
      setCurrentStep(foundRepo ? 'board' : 'clone');
    } else {
      setCurrentStep('add-repo');
    }
  }, [open, user, persistedAgentPending, path, repoById, boardById, worktreeById]);

  // Initialize branch name when user is available
  useEffect(() => {
    if (user && !branchName) {
      setBranchName(`private-${usernameSlug}`);
    }
  }, [user, branchName, usernameSlug]);

  // Initialize worktree name for own-repo path
  useEffect(() => {
    if (path === 'own-repo' && !worktreeName) {
      setWorktreeName('my-worktree');
    }
  }, [path, worktreeName]);

  // ─── Auto-advance: Watch repoById for clone completion ──
  useEffect(() => {
    if (currentStep !== 'clone' || !loading) return;

    if (path === 'persisted-agent') {
      // Look for openclaw repo
      for (const [id, repo] of repoById) {
        if (repo.slug === OPENCLAW_REPO_SLUG || repo.remote_url?.includes('agor-openclaw')) {
          setCreatedRepoId(id);
          setLoading(false);
          setError(null);
          if (cloneTimeoutRef.current) {
            clearTimeout(cloneTimeoutRef.current);
            cloneTimeoutRef.current = null;
          }
          setCurrentStep('board');
          return;
        }
      }
    } else if (path === 'own-repo' && repoUrl) {
      // Look for user's repo by URL or slug
      for (const [id, repo] of repoById) {
        if (
          repo.remote_url === repoUrl ||
          (repoSlug && repo.slug === repoSlug) ||
          repo.local_path === localRepoPath
        ) {
          setCreatedRepoId(id);
          setLoading(false);
          setError(null);
          if (cloneTimeoutRef.current) {
            clearTimeout(cloneTimeoutRef.current);
            cloneTimeoutRef.current = null;
          }
          setCurrentStep('board');
          return;
        }
      }
    }
  }, [currentStep, loading, path, repoById, repoUrl, repoSlug, localRepoPath]);

  // ─── Auto-advance: Watch boardById for board creation ──
  useEffect(() => {
    if (currentStep !== 'board' || !loading) return;

    for (const [id] of boardById) {
      if (id === createdBoardId) {
        setLoading(false);
        setCurrentStep('worktree');
        return;
      }
    }
  }, [currentStep, loading, boardById, createdBoardId]);

  // ─── Auto-advance: Watch worktreeById for worktree creation ──
  useEffect(() => {
    if (currentStep !== 'worktree' || !loading) return;

    if (createdWorktreeId) {
      for (const [id] of worktreeById) {
        if (id === createdWorktreeId) {
          setLoading(false);
          setCurrentStep('api-keys');
          return;
        }
      }
    }
  }, [currentStep, loading, worktreeById, createdWorktreeId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cloneTimeoutRef.current) {
        clearTimeout(cloneTimeoutRef.current);
      }
    };
  }, []);

  // ─── Step Handlers ────────────────────────────────

  // Persist onboarding progress to user preferences so restarts can resume
  const saveOnboardingProgress = useCallback(
    (updates: { path?: WizardPath; boardId?: string; worktreeId?: string }) => {
      if (!user) return;
      const current = user.preferences?.onboarding || {};
      const prefs: Record<string, unknown> = {
        ...user.preferences,
        onboarding: { ...current, ...updates },
      };
      if (updates.boardId) {
        prefs.mainBoardId = updates.boardId;
      }
      onUpdateUser(user.user_id, { preferences: prefs as UserPreferences });
    },
    [user, onUpdateUser]
  );

  const handleSelectPath = useCallback(
    (selectedPath: WizardPath) => {
      setPath(selectedPath);
      setError(null);

      // Persist chosen path immediately
      saveOnboardingProgress({ path: selectedPath });

      if (selectedPath === 'persisted-agent') {
        // Check if openclaw repo already exists
        for (const [id, repo] of repoById) {
          if (repo.slug === OPENCLAW_REPO_SLUG || repo.remote_url?.includes('agor-openclaw')) {
            setCreatedRepoId(id);
            setCurrentStep('board');
            return;
          }
        }
        setCurrentStep('clone');
      } else {
        setCurrentStep('add-repo');
      }
    },
    [repoById, saveOnboardingProgress]
  );

  const handleStartClone = useCallback(() => {
    setError(null);
    setLoading(true);

    if (path === 'persisted-agent') {
      onCreateRepo({
        url: effectiveOpenclawUrl,
        slug: OPENCLAW_REPO_SLUG,
        default_branch: 'main',
      });
    } else if (repoMode === 'remote') {
      onCreateRepo({
        url: repoUrl,
        slug: repoSlug || '',
        default_branch: 'main',
      });
    } else {
      onCreateLocalRepo({
        path: localRepoPath,
        slug: repoSlug || undefined,
      });
    }

    // Set timeout
    cloneTimeoutRef.current = setTimeout(() => {
      setLoading(false);
      setError('Clone timed out. Please check the URL and try again.');
    }, CLONE_TIMEOUT_MS);
  }, [
    path,
    effectiveOpenclawUrl,
    repoMode,
    repoUrl,
    repoSlug,
    localRepoPath,
    onCreateRepo,
    onCreateLocalRepo,
  ]);

  const handleCreateBoard = useCallback(async () => {
    // If we already have a board from a prior run, skip creation
    const existingBoardId = user?.preferences?.mainBoardId;
    if (existingBoardId && boardById.has(existingBoardId)) {
      setCreatedBoardId(existingBoardId);
      setLoading(false);
      setCurrentStep('worktree');
      return;
    }

    setError(null);
    setLoading(true);

    const displayName = user?.name || user?.email?.split('@')[0] || 'My';
    try {
      if (!client) throw new Error('Not connected');
      const board = await client.service('boards').create({
        name: `${displayName}'s Board`,
        icon: '\u{1F3E0}',
      });
      if (board?.board_id) {
        setCreatedBoardId(board.board_id);
        // Persist board ID immediately so restarts don't re-create it
        saveOnboardingProgress({ boardId: board.board_id });
        setLoading(false);
        setCurrentStep('worktree');
      }
    } catch (err) {
      setLoading(false);
      setError(`Failed to create board: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client, user, boardById, saveOnboardingProgress]);

  const handleCreateWorktree = useCallback(async () => {
    if (!createdRepoId || !createdBoardId) {
      setError('Missing repo or board. Please go back and try again.');
      return;
    }

    setError(null);
    setLoading(true);

    const wtName = path === 'persisted-agent' ? 'persisted-agent' : worktreeName;
    const ref = sanitizeBranchName(branchName);

    try {
      const worktree = await onCreateWorktree(createdRepoId, {
        name: wtName,
        ref,
        createBranch: true,
        sourceBranch: 'main',
        pullLatest: true,
        boardId: createdBoardId,
      });

      if (worktree) {
        setCreatedWorktreeId(worktree.worktree_id);
        // Persist worktree ID so restarts don't re-create it
        saveOnboardingProgress({ worktreeId: worktree.worktree_id });

        // Tag persisted agent worktrees
        if (path === 'persisted-agent' && onUpdateWorktree) {
          const agentConfig: PersistedAgentConfig = {
            kind: 'persisted-agent',
            displayName: 'Persisted Agent',
            frameworkRepo: OPENCLAW_REPO_SLUG,
            createdViaOnboarding: true,
          };
          onUpdateWorktree(worktree.worktree_id, {
            custom_context: { ...worktree.custom_context, agent: agentConfig },
          });
        }

        setLoading(false);
        setCurrentStep('api-keys');
      } else {
        setLoading(false);
        setError('Failed to create worktree. Please try again.');
      }
    } catch (err) {
      setLoading(false);
      setError(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [
    createdRepoId,
    createdBoardId,
    path,
    worktreeName,
    branchName,
    onCreateWorktree,
    onUpdateWorktree,
    saveOnboardingProgress,
  ]);

  const handleSaveApiKey = useCallback(async () => {
    if (!user || !apiKey.trim()) return;

    setError(null);
    setLoading(true);

    try {
      const keyName = apiKeyNameForAgent(selectedAgent);
      onUpdateUser(user.user_id, {
        api_keys: { [keyName]: apiKey.trim() },
      });
      setLoading(false);
      setCurrentStep('launch');
    } catch (err) {
      setLoading(false);
      setError(`Failed to save API key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [user, apiKey, selectedAgent, onUpdateUser]);

  const handleAdvanceFromApiKeys = useCallback(() => {
    setCurrentStep('launch');
  }, []);

  const handleLaunch = useCallback(async () => {
    if (!createdWorktreeId || !createdBoardId) {
      setError('Missing worktree or board.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const sessionId = await onCreateSession(
        {
          worktree_id: createdWorktreeId,
          agent: selectedAgent,
        },
        createdBoardId
      );

      if (sessionId) {
        setCreatedSessionId(sessionId);
        setLoading(false);
      } else {
        setLoading(false);
        setError('Failed to create session. Please try again.');
      }
    } catch (err) {
      setLoading(false);
      setError(`Failed to launch session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [createdWorktreeId, createdBoardId, selectedAgent, onCreateSession]);

  const handleFinish = useCallback(() => {
    if (!createdWorktreeId || !createdSessionId || !createdBoardId || !path) return;

    onComplete({
      worktreeId: createdWorktreeId,
      sessionId: createdSessionId,
      boardId: createdBoardId,
      path,
    });
  }, [createdWorktreeId, createdSessionId, createdBoardId, path, onComplete]);

  const handleSkip = useCallback(() => {
    if (!user) return;
    onUpdateUser(user.user_id, { onboarding_completed: true });
    // Close immediately - the parent will handle setting the state
    onComplete({
      worktreeId: '',
      sessionId: '',
      boardId: '',
      path: 'persisted-agent',
    });
  }, [user, onUpdateUser, onComplete]);

  const handleBack = useCallback(() => {
    setError(null);
    const idx = stepIndex;
    if (idx > 0) {
      setCurrentStep(steps[idx - 1]);
    }
  }, [stepIndex, steps]);

  // ─── Render Helpers ───────────────────────────────

  const renderWelcome = () => (
    <div style={{ textAlign: 'center', padding: '24px 0' }}>
      <Title level={3} style={{ marginBottom: 8 }}>
        Welcome to Agor
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 32, fontSize: 15 }}>
        Let's get you set up with your first agent conversation.
      </Paragraph>

      <Space
        direction="vertical"
        size="middle"
        style={{ width: '100%', maxWidth: 400, margin: '0 auto' }}
      >
        <Button
          type="primary"
          size="large"
          block
          icon={<ThunderboltOutlined />}
          onClick={() => handleSelectPath('persisted-agent')}
          style={{ height: 56, fontSize: 16 }}
        >
          Set up your persisted agent
        </Button>
        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: -8 }}>
          Clone the agor-openclaw workspace with pre-configured tasks and templates
        </Text>

        <div style={{ margin: '8px 0' }}>
          <Text type="secondary">or</Text>
        </div>

        <Button
          size="large"
          block
          icon={<FolderOpenOutlined />}
          onClick={() => handleSelectPath('own-repo')}
          style={{ height: 56, fontSize: 16 }}
        >
          I have my own repo
        </Button>
        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: -8 }}>
          Connect your own repository and start coding with an AI agent
        </Text>
      </Space>
    </div>
  );

  const renderAddRepo = () => (
    <div style={{ padding: '16px 0' }}>
      <Title level={4}>Add Your Repository</Title>
      <Paragraph type="secondary">
        Connect a Git repository to get started. You can clone a remote repo or register a local
        one.
      </Paragraph>

      <Space style={{ marginBottom: 16 }}>
        <Button
          type={repoMode === 'remote' ? 'primary' : 'default'}
          size="small"
          onClick={() => setRepoMode('remote')}
        >
          Remote URL
        </Button>
        <Button
          type={repoMode === 'local' ? 'primary' : 'default'}
          size="small"
          onClick={() => setRepoMode('local')}
        >
          Local Path
        </Button>
      </Space>

      {repoMode === 'remote' ? (
        <Form layout="vertical">
          <Form.Item label="Git URL" required>
            <Input
              placeholder="https://github.com/user/repo.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="Slug (optional)">
            <Input
              placeholder="user/repo"
              value={repoSlug}
              onChange={(e) => setRepoSlug(e.target.value)}
            />
          </Form.Item>
        </Form>
      ) : (
        <Form layout="vertical">
          <Form.Item label="Local Path" required>
            <Input
              placeholder="/path/to/your/repo"
              value={localRepoPath}
              onChange={(e) => setLocalRepoPath(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="Slug (optional)">
            <Input
              placeholder="local/repo"
              value={repoSlug}
              onChange={(e) => setRepoSlug(e.target.value)}
            />
          </Form.Item>
        </Form>
      )}

      <Button
        type="primary"
        onClick={handleStartClone}
        loading={loading}
        disabled={repoMode === 'remote' ? !repoUrl.trim() : !localRepoPath.trim()}
      >
        {repoMode === 'remote' ? 'Clone Repository' : 'Add Local Repository'}
      </Button>
    </div>
  );

  const renderClone = () => (
    <div style={{ textAlign: 'center', padding: '32px 0' }}>
      {loading ? (
        <>
          <Spin size="large" />
          <Paragraph style={{ marginTop: 16 }}>
            {path === 'persisted-agent'
              ? 'Cloning agor-openclaw repository...'
              : 'Setting up your repository...'}
          </Paragraph>
          <Text type="secondary">This may take a moment</Text>
        </>
      ) : error ? (
        <>
          <Alert
            type="error"
            message={error}
            showIcon
            style={{ marginBottom: 16, textAlign: 'left' }}
          />
          <Button type="primary" onClick={handleStartClone}>
            Retry
          </Button>
        </>
      ) : (
        <>
          <Result
            status="success"
            title="Repository Ready"
            subTitle={
              path === 'persisted-agent'
                ? 'agor-openclaw has been cloned successfully.'
                : 'Your repository is ready.'
            }
          />
          <Button type="primary" onClick={() => setCurrentStep('board')}>
            Continue
          </Button>
        </>
      )}
    </div>
  );

  const renderBoard = () => (
    <div style={{ textAlign: 'center', padding: '32px 0' }}>
      <Title level={4}>Create Your Personal Board</Title>
      <Paragraph type="secondary">
        Boards are spatial canvases where you organize worktrees, sessions, and AI agents. We'll
        create a personal board for you.
      </Paragraph>

      {loading ? (
        <Spin size="large" />
      ) : error ? (
        <>
          <Alert
            type="error"
            message={error}
            showIcon
            style={{ marginBottom: 16, textAlign: 'left' }}
          />
          <Button type="primary" onClick={handleCreateBoard}>
            Retry
          </Button>
        </>
      ) : createdBoardId ? (
        <>
          <Result
            icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
            title="Board Created"
          />
          <Button type="primary" onClick={() => setCurrentStep('worktree')}>
            Continue
          </Button>
        </>
      ) : (
        <Button
          type="primary"
          size="large"
          icon={<ExperimentOutlined />}
          onClick={handleCreateBoard}
        >
          Create Board
        </Button>
      )}
    </div>
  );

  const renderWorktree = () => (
    <div style={{ padding: '16px 0' }}>
      <Title level={4}>Create Your Worktree</Title>
      <Paragraph type="secondary">
        A worktree is an isolated copy of your repo with its own branch.
        {path === 'persisted-agent'
          ? " We'll set up a worktree for your persisted agent."
          : ' Choose a name and branch for your worktree.'}
      </Paragraph>

      <Form layout="vertical">
        {path === 'own-repo' && (
          <Form.Item label="Worktree Name">
            <Input
              placeholder="my-worktree"
              value={worktreeName}
              onChange={(e) => setWorktreeName(sanitizeBranchName(e.target.value))}
            />
          </Form.Item>
        )}
        <Form.Item label="Branch Name">
          <Input
            placeholder={`private-${usernameSlug}`}
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            addonBefore="branch:"
          />
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            A personal branch will be created from main
          </Text>
        </Form.Item>
      </Form>

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <Button
        type="primary"
        onClick={handleCreateWorktree}
        loading={loading}
        disabled={!branchName.trim()}
      >
        Create Worktree
      </Button>
    </div>
  );

  const renderApiKeys = () => (
    <div style={{ padding: '16px 0' }}>
      <Title level={4}>Choose Your Agent & Configure Credentials</Title>

      <Form layout="vertical">
        <Form.Item label="Agent">
          <Select
            value={selectedAgent}
            onChange={(value) => {
              setSelectedAgent(value);
              setApiKey('');
              setError(null);
            }}
            options={[
              { value: 'claude-code', label: 'Claude Code (Recommended)' },
              { value: 'codex', label: 'Codex (OpenAI)' },
              { value: 'gemini', label: 'Gemini' },
              { value: 'opencode', label: 'OpenCode' },
            ]}
            style={{ width: '100%' }}
          />
        </Form.Item>
      </Form>

      {hasKeyForAgent(selectedAgent) ? (
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <Result
            icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
            title={`${AGENT_LABELS[selectedAgent]} API Key Configured`}
            subTitle={`You're all set to use ${AGENT_LABELS[selectedAgent]}.`}
          />
          <Button type="primary" onClick={handleAdvanceFromApiKeys}>
            Continue
          </Button>
        </div>
      ) : (
        <>
          {selectedAgent === 'claude-code' && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16, textAlign: 'left' }}
              message="Using a Claude Max or Pro plan?"
              description={
                <span>
                  If the system user running Agor is already authenticated with the{' '}
                  <Text code>claude</Text> CLI, you can skip this step — sessions will use that
                  authentication automatically.
                </span>
              }
            />
          )}

          {AGENT_KEY_CONSOLES[selectedAgent] && (
            <Paragraph type="secondary">
              You need an API key for {AGENT_LABELS[selectedAgent]}. Get one at{' '}
              <a
                href={AGENT_KEY_CONSOLES[selectedAgent]?.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {AGENT_KEY_CONSOLES[selectedAgent]?.label}
              </a>
            </Paragraph>
          )}

          {selectedAgent === 'opencode' && (
            <Paragraph type="secondary">
              OpenCode supports 75+ LLM providers. Configure the appropriate API key for your chosen
              provider below.
            </Paragraph>
          )}

          <Form layout="vertical">
            <Form.Item label={`${apiKeyNameForAgent(selectedAgent)}`}>
              <Input.Password
                placeholder={apiKeyPlaceholder(selectedAgent)}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Form.Item>
          </Form>

          {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

          <Space>
            <Button
              type="primary"
              onClick={handleSaveApiKey}
              loading={loading}
              disabled={!apiKey.trim()}
              icon={<KeyOutlined />}
            >
              Save API Key
            </Button>
            <Button type="link" onClick={handleAdvanceFromApiKeys}>
              Skip for now
            </Button>
          </Space>
        </>
      )}
    </div>
  );

  const renderLaunch = () => (
    <div style={{ textAlign: 'center', padding: '24px 0' }}>
      {!createdSessionId ? (
        <>
          <Title level={4}>Ready to Launch</Title>
          <Paragraph type="secondary">
            {path === 'persisted-agent'
              ? "Your persisted agent is set up. Let's create your first session!"
              : "Your worktree is ready. Let's launch an agent session!"}
          </Paragraph>

          {error && (
            <Alert
              type="error"
              message={error}
              showIcon
              style={{ marginBottom: 16, textAlign: 'left' }}
            />
          )}

          <Button
            type="primary"
            size="large"
            icon={<RocketOutlined />}
            onClick={handleLaunch}
            loading={loading}
          >
            Launch Agent Session
          </Button>
        </>
      ) : (
        <>
          <Result
            status="success"
            title={
              path === 'persisted-agent'
                ? 'Say hello to your agent!'
                : 'Tell your agent what to work on!'
            }
            subTitle="Your Claude Code session is ready. Close this wizard to start chatting."
          />
          <Button type="primary" size="large" onClick={handleFinish}>
            Let's go
          </Button>
        </>
      )}
    </div>
  );

  const renderStepContent = () => {
    switch (currentStep) {
      case 'welcome':
        return renderWelcome();
      case 'add-repo':
        return renderAddRepo();
      case 'clone':
        return renderClone();
      case 'board':
        return renderBoard();
      case 'worktree':
        return renderWorktree();
      case 'api-keys':
        return renderApiKeys();
      case 'launch':
        return renderLaunch();
      default:
        return null;
    }
  };

  // ─── Steps display config ────────────────────────

  const stepsItems = useMemo(() => {
    if (!path) return [];

    const allSteps = getStepsForPath(path);
    // Don't include 'welcome' in the steps indicator
    const displaySteps = allSteps.filter((s) => s !== 'welcome');

    const labelMap: Record<WizardStep, string> = {
      welcome: 'Welcome',
      'add-repo': 'Add Repo',
      clone: 'Clone',
      board: 'Board',
      worktree: 'Worktree',
      'api-keys': 'API Keys',
      launch: 'Launch',
    };

    const iconMap: Record<WizardStep, React.ReactNode> = {
      welcome: null,
      'add-repo': <FolderOpenOutlined />,
      clone: <CloudDownloadOutlined />,
      board: <ExperimentOutlined />,
      worktree: <FolderOpenOutlined />,
      'api-keys': <KeyOutlined />,
      launch: <RocketOutlined />,
    };

    return displaySteps.map((step) => ({
      key: step,
      title: labelMap[step],
      icon: iconMap[step],
    }));
  }, [path]);

  const currentStepDisplay = useMemo(() => {
    if (!path || currentStep === 'welcome') return -1;
    const displaySteps = getStepsForPath(path).filter((s) => s !== 'welcome');
    return displaySteps.indexOf(currentStep);
  }, [path, currentStep]);

  // ─── Auto-trigger steps that should auto-start ────
  useEffect(() => {
    // Auto-start clone when entering clone step for persisted agent
    if (
      currentStep === 'clone' &&
      path === 'persisted-agent' &&
      !loading &&
      !error &&
      !createdRepoId
    ) {
      handleStartClone();
    }
  }, [currentStep, path, loading, error, createdRepoId, handleStartClone]);

  // Auto-start board creation
  useEffect(() => {
    if (currentStep === 'board' && !loading && !error && !createdBoardId) {
      handleCreateBoard();
    }
  }, [currentStep, loading, error, createdBoardId, handleCreateBoard]);

  // ─── Footer ───────────────────────────────────────

  const footer = (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0 8px',
      }}
    >
      {/* Left: Resources */}
      <Space size="middle">
        <a
          href="https://agor.live/guide/getting-started"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12, color: token.colorTextSecondary }}
        >
          Getting Started Docs
        </a>
        <a
          href="https://github.com/preset-io/agor"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12, color: token.colorTextSecondary }}
        >
          GitHub
        </a>
      </Space>

      {/* Right: Skip */}
      <Popconfirm
        title="Skip setup?"
        description={
          <div style={{ maxWidth: 250 }}>
            Are you sure? Your agent has been waiting their whole life to meet you.
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
    </div>
  );

  // ─── Render ───────────────────────────────────────

  return (
    <Modal
      open={open}
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={footer}
      width={640}
      styles={{
        body: {
          minHeight: 360,
          padding: '24px 32px',
        },
      }}
    >
      {/* Steps indicator (only when path is chosen) */}
      {path && currentStep !== 'welcome' && (
        <Steps
          current={currentStepDisplay}
          size="small"
          items={stepsItems}
          style={{ marginBottom: 24 }}
        />
      )}

      {/* Step content */}
      {renderStepContent()}

      {/* Back button (where appropriate) */}
      {currentStep !== 'welcome' && currentStep !== 'launch' && stepIndex > 1 && !loading && (
        <div style={{ marginTop: 16 }}>
          <Button type="link" onClick={handleBack} style={{ padding: 0 }}>
            &larr; Back
          </Button>
        </div>
      )}
    </Modal>
  );
}
