/**
 * OnboardingWizard - Multi-step wizard for new user onboarding
 *
 * Two paths:
 * - Assistant: Clone assistant framework repo -> create board -> create worktree -> API keys -> launch
 * - Own Repo: Add user repo -> create board -> create worktree -> API keys -> launch
 *
 * Replaces GettingStartedPopover entirely.
 */

import type {
  AgenticToolName,
  AssistantConfig,
  AuthCheckResult,
  Board,
  CreateLocalRepoRequest,
  CreateRepoRequest,
  Repo,
  UpdateUserInput,
  User,
  UserPreferences,
  Worktree,
} from '@agor-live/client';
import {
  extractSlugFromUrl,
  isValidSlug,
  normalizeRepoUrl,
  TOOL_API_KEY_NAMES,
} from '@agor-live/client';
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
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Spin,
  Steps,
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
import { extractSlugFromPath } from '../../utils/repoSlug';
import type { NewSessionConfig } from '../NewSessionModal/NewSessionModal';

const { Text, Title, Paragraph } = Typography;
const { useToken } = theme;

// ─── Constants ──────────────────────────────────────────

const CLONE_TIMEOUT_MS = 120_000;

const ASSISTANT_BOOT_PROMPT = `You are starting your first session as an Agor assistant.

Read the framework files in this worktree. Then introduce yourself — show that you understand your role as a persistent, memory-aware assistant, not a generic chatbot. Keep your intro brief and warm.

Context: this is a fresh Agor installation, assistant path, first session.`;

// ─── Types ──────────────────────────────────────────────

type WizardPath = 'assistant' | 'own-repo';

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
  onCreateRepo: (data: CreateRepoRequest) => Promise<void>;
  onCreateLocalRepo: (data: CreateLocalRepoRequest) => void | Promise<void>;
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
  onUpdateUser: (userId: string, updates: UpdateUserInput) => Promise<void>;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => Promise<void>;
  onCheckAuth?: (tool: AgenticToolName, apiKey?: string) => Promise<AuthCheckResult>;

  // Config from health endpoint
  assistantPending?: boolean;
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
  if (path === 'assistant') {
    return ['welcome', 'api-keys', 'clone', 'board', 'worktree', 'launch'];
  }
  if (path === 'own-repo') {
    return ['welcome', 'api-keys', 'add-repo', 'clone', 'board', 'worktree', 'launch'];
  }
  return ['welcome'];
}

function getStepIndex(steps: WizardStep[], step: WizardStep): number {
  return steps.indexOf(step);
}

function apiKeyNameForAgent(agent: AgenticToolName): string {
  // opencode has no canonical key of its own; wizard collects an Anthropic key
  // and routes it to the claude-code bucket (see handleSaveApiKey).
  return TOOL_API_KEY_NAMES[agent] ?? 'ANTHROPIC_API_KEY';
}

function apiKeyPlaceholder(agent: AgenticToolName): string {
  switch (agent) {
    case 'claude-code':
      return 'sk-ant-...';
    case 'codex':
      return 'sk-...';
    case 'gemini':
      return 'AIza...';
    case 'copilot':
      return 'ghp_...';
    default:
      return 'sk-ant-...';
  }
}

const AGENT_LABELS: Record<AgenticToolName, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex (OpenAI)',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
};

/**
 * A repo is "usable" once its clone has actually completed. After PR #1126
 * the daemon pre-creates a placeholder row with `clone_status: 'cloning'`
 * before the executor runs — matching it as if it were finished caused the
 * wizard to auto-advance off the `'clone'` step within ~50ms, which then
 * dropped the subsequent `repo:cloneError` event (its listener filters on
 * `currentStep === 'clone'`). Legacy rows have no `clone_status`; treat
 * those as ready too so existing repos still match.
 */
function isRepoReady(repo: Repo): boolean {
  return repo.clone_status === 'ready' || repo.clone_status === undefined;
}

/**
 * Find the framework repo only when it's actually usable. Uses `readyOnly`
 * so non-ready candidates are excluded **before** priority selection —
 * a stale failed/cloning private fork never hides a ready public repo.
 */
function findReadyFrameworkRepo(repoById: Map<string, Repo>): [string, Repo] | undefined {
  return findFrameworkRepo(repoById, { readyOnly: true });
}

/**
 * Find a repo in the wizard's in-memory map that matches the user's input.
 * Used by both the clone-complete auto-advance effect and the board/worktree
 * safety-net effect — centralised here so the match criteria cannot drift
 * between the two.
 *
 * Placeholder rows (`clone_status: 'cloning' | 'failed'`) are skipped — the
 * caller asked "is the clone done yet?", and the answer for a placeholder
 * is no.
 */
function findMatchingRepoId(
  repoById: Map<string, Repo>,
  criteria: { remoteUrl?: string; slug?: string; localPath?: string }
): string | null {
  const normalizedInput = criteria.remoteUrl ? normalizeRepoUrl(criteria.remoteUrl) : '';
  for (const [id, repo] of repoById) {
    if (!isRepoReady(repo)) continue;
    if (
      (normalizedInput &&
        repo.remote_url &&
        normalizeRepoUrl(repo.remote_url) === normalizedInput) ||
      (criteria.slug && repo.slug === criteria.slug) ||
      (criteria.localPath && repo.local_path === criteria.localPath)
    ) {
      return id;
    }
  }
  return null;
}

const AGENT_KEY_CONSOLES: Record<AgenticToolName, { label: string; url: string } | null> = {
  'claude-code': { label: 'console.anthropic.com', url: 'https://console.anthropic.com/' },
  codex: { label: 'platform.openai.com', url: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'aistudio.google.com', url: 'https://aistudio.google.com/apikey' },
  copilot: { label: 'github.com/features/copilot', url: 'https://github.com/features/copilot' },
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
  onCheckAuth,
  assistantPending,
  frameworkRepoUrl,
  systemCredentials,
}: OnboardingWizardProps) {
  const { token } = useToken();

  // ─── State ────────────────────────────────────────
  const [path, setPath] = useState<WizardPath | null>(null);
  const [currentStep, rawSetCurrentStep] = useState<WizardStep>('welcome');

  // Funnel ALL step transitions through this wrapper. In dev it logs every
  // transition with caller context (use the browser console to follow the
  // wizard's path through its steps). This makes step-transition bugs —
  // historically the biggest source of regressions in this component —
  // immediately visible.
  //
  // Rule of thumb: any time you'd reach for `rawSetCurrentStep`, use this
  // instead. Auto-advance effects watching WS events also go through here.
  const setCurrentStep = useCallback((next: WizardStep) => {
    rawSetCurrentStep((prev) => {
      if (import.meta.env.DEV && prev !== next) {
        // eslint-disable-next-line no-console
        console.debug(`[OnboardingWizard] step: ${prev} → ${next}`);
      }
      return next;
    });
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Step-specific state
  const [repoUrl, setRepoUrl] = useState('');
  const [repoSlug, setRepoSlug] = useState('');
  const [localRepoPath, setLocalRepoPath] = useState('');
  const [repoMode, setRepoMode] = useState<'remote' | 'local'>('remote');
  const [branchName, setBranchName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>('claude-code');
  const [testAuthLoading, setTestAuthLoading] = useState(false);
  const [testAuthResult, setTestAuthResult] = useState<AuthCheckResult | null>(null);
  // Lets the user opt out of detected auth (CLI/OAuth/file-probe) and paste
  // a key manually — useful when the detected method isn't what they want
  // (e.g. ChatGPT OAuth detected but they prefer a work API key) or when
  // our probe is wrong. Resets on agent change and on wizard reset.
  const [overrideDetectedAuth, setOverrideDetectedAuth] = useState(false);

  // Created resource IDs
  const [createdRepoId, setCreatedRepoId] = useState<string | null>(null);
  const [createdBoardId, setCreatedBoardId] = useState<string | null>(null);
  const [createdWorktreeId, setCreatedWorktreeId] = useState<string | null>(null);

  // Timeout ref for clone
  const cloneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Elapsed time for clone progress
  const [cloneElapsedSeconds, setCloneElapsedSeconds] = useState(0);
  const cloneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Repo IDs that were already failed when the current clone attempt started.
  // The failure watcher ignores these so a stale row from a prior attempt never
  // immediately cancels a new retry before the daemon has a chance to replace it.
  const knownFailedRepoIdsRef = useRef<Set<string>>(new Set());
  // Tracks which agent we've already auto-tested on the current api-keys
  // visit, so re-rendering the step doesn't re-fire the test endlessly.
  const autoTestedAgentRef = useRef<string | null>(null);

  // ─── Derived ──────────────────────────────────────
  const steps = useMemo(() => getStepsForPath(path), [path]);
  const stepIndex = getStepIndex(steps, currentStep);
  const usernameSlug = getUsernameSlug(user);
  const effectiveFrameworkUrl = frameworkRepoUrl || FRAMEWORK_REPO_URL;

  // Claude Code accepts either an Anthropic API key or a Pro/Max subscription
  // OAuth token (from `claude setup-token`). Either is a valid credential.
  // Per-tool credentials live under `agentic_tools[tool][envVarName]` (boolean
  // presence flags on the public DTO).
  const claudeFields = user?.agentic_tools?.['claude-code'];
  const codexFields = user?.agentic_tools?.codex;
  const geminiFields = user?.agentic_tools?.gemini;
  const copilotFields = user?.agentic_tools?.copilot;
  const hasAnthropicKey = !!(
    claudeFields?.ANTHROPIC_API_KEY ||
    claudeFields?.CLAUDE_CODE_OAUTH_TOKEN ||
    user?.env_vars?.ANTHROPIC_API_KEY ||
    systemCredentials?.ANTHROPIC_API_KEY
  );
  const hasOpenAIKey = !!(
    codexFields?.OPENAI_API_KEY ||
    user?.env_vars?.OPENAI_API_KEY ||
    systemCredentials?.OPENAI_API_KEY
  );
  const hasGeminiKey = !!(
    geminiFields?.GEMINI_API_KEY ||
    user?.env_vars?.GEMINI_API_KEY ||
    systemCredentials?.GEMINI_API_KEY
  );

  const hasCopilotToken = !!(
    copilotFields?.COPILOT_GITHUB_TOKEN ||
    user?.env_vars?.COPILOT_GITHUB_TOKEN ||
    (systemCredentials as Record<string, unknown>)?.COPILOT_GITHUB_TOKEN
  );

  const hasKeyForAgent = (agent: AgenticToolName): boolean => {
    switch (agent) {
      case 'claude-code':
        return hasAnthropicKey;
      case 'codex':
        return hasOpenAIKey;
      case 'gemini':
        return hasGeminiKey;
      case 'copilot':
        return hasCopilotToken;
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
      // No prior state — auto-select assistant path if flag was set (e.g. by existing installs)
      if (assistantPending && !path) {
        setPath('assistant');
      }
      return;
    }

    // We have prior onboarding state — resume from where user left off
    resumedRef.current = true;
    // Map legacy 'persisted-agent' to 'assistant'
    const resumedPath: WizardPath =
      onboarding.path === 'persisted-agent' ? 'assistant' : (onboarding.path as WizardPath);
    setPath(resumedPath);

    // Restore created resource IDs
    if (mainBoardId) {
      setCreatedBoardId(mainBoardId);
    } else if (onboarding.boardId) {
      setCreatedBoardId(onboarding.boardId);
    }

    // Restore repoId so the worktree step doesn't fail "Missing repo or board"
    // on resume. The safety-net effect can re-derive it for the assistant path
    // (framework slug) but has no signal for an own-repo resume because
    // `repoUrl`/`localRepoPath` are local state and reset to ''.
    if (onboarding.repoId && repoById.has(onboarding.repoId)) {
      setCreatedRepoId(onboarding.repoId);
    }

    if (onboarding.worktreeId) {
      setCreatedWorktreeId(onboarding.worktreeId);
    }

    // Figure out which step to resume from
    if (onboarding.worktreeId && worktreeById.has(onboarding.worktreeId)) {
      // Worktree exists — go to launch (api-keys now comes before clone/add-repo)
      setCurrentStep('launch');
    } else if (mainBoardId && boardById.has(mainBoardId)) {
      // Board exists — go to worktree creation
      setCurrentStep('worktree');
    } else if (onboarding.repoId && repoById.has(onboarding.repoId)) {
      // Repo is registered (already restored above) — go straight to board
      setCurrentStep('board');
    } else if (resumedPath === 'assistant') {
      // Assistant path may have a framework repo cloned outside this wizard
      // (or under a prior onboarding without persisted repoId). Try to find it.
      const found = findReadyFrameworkRepo(repoById);
      if (found) {
        setCreatedRepoId(found[0]);
        setCurrentStep('board');
      } else {
        // Nothing created yet — restart from api-keys (first real step in new flow)
        setCurrentStep('api-keys');
      }
    } else {
      // own-repo with nothing created — restart from api-keys
      setCurrentStep('api-keys');
    }
  }, [
    open,
    user,
    assistantPending,
    path,
    repoById,
    boardById,
    worktreeById, // own-repo with nothing created — restart from api-keys
    setCurrentStep,
  ]);

  // Initialize branch name once when user first loads (ref guards against re-init on edit)
  const branchNameInitRef = useRef(false);
  useEffect(() => {
    if (user && !branchNameInitRef.current) {
      branchNameInitRef.current = true;
      setBranchName(`private-${usernameSlug}`);
    }
  }, [user, usernameSlug]);

  // ─── Auto-advance: Watch repoById for clone completion ──
  // This is the ONE legitimately async step: clone completion is signalled
  // by a WebSocket event landing in `repoById`. Every other step transition
  // in the wizard is owned by its handler (imperative). If you find yourself
  // adding another effect that calls `setCurrentStep` based on a service map,
  // think twice — most operations are synchronous from the wizard's POV.
  useEffect(() => {
    if (currentStep !== 'clone' || !loading) return;

    if (path === 'assistant') {
      // Only advance once the framework repo is actually cloned. Matching
      // the pre-created placeholder (`clone_status: 'cloning'`) would push
      // us off the clone step before `repo:cloneError` arrives, so a real
      // failure would never reach `handleCloneError`. See `isRepoReady`.
      const found = findReadyFrameworkRepo(repoById);
      if (found) {
        setCreatedRepoId(found[0]);
        setLoading(false);
        setError(null);
        if (cloneTimeoutRef.current) {
          clearTimeout(cloneTimeoutRef.current);
          cloneTimeoutRef.current = null;
        }
        setCurrentStep('board');
        return;
      }
    } else if (path === 'own-repo' && (repoUrl || localRepoPath)) {
      const matchId = findMatchingRepoId(repoById, {
        remoteUrl: repoUrl,
        slug: repoSlug,
        localPath: localRepoPath,
      });
      if (matchId) {
        setCreatedRepoId(matchId);
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
  }, [currentStep, loading, path, repoById, repoUrl, repoSlug, localRepoPath, setCurrentStep]);

  // ─── Safety net: ensure createdRepoId is set when reaching board/worktree ──
  useEffect(() => {
    if (createdRepoId || (currentStep !== 'board' && currentStep !== 'worktree')) return;
    const matchId = findMatchingRepoId(repoById, {
      remoteUrl: repoUrl,
      slug: repoSlug,
      localPath: localRepoPath,
    });
    if (matchId) {
      setCreatedRepoId(matchId);
      return;
    }
    // For assistant path, find framework repo (placeholders excluded —
    // `createdRepoId` should point at a real, cloned repo).
    if (path === 'assistant') {
      const found = findReadyFrameworkRepo(repoById);
      if (found) {
        setCreatedRepoId(found[0]);
      }
    }
  }, [currentStep, createdRepoId, repoById, repoUrl, repoSlug, localRepoPath, path]);

  // No auto-advance for board or worktree creation: handleCreateBoard and
  // handleCreateWorktree own their success/failure transitions explicitly
  // because both are synchronous from the wizard's perspective (the daemon
  // returns the created row from the create call). Prior effects watching
  // boardById / worktreeById raced the handlers — see git history.

  // ─── Watch repoById for clone failure (state-driven, race-free) ──
  // Events can arrive while the listener closure still has `loading=false`
  // (between handleStartClone() setting loading=true and the next React render
  // re-registering the effect). Reading from authoritative repoById covers that
  // race without relying on event delivery. Pre-existing failed rows (stale from
  // prior attempts) are excluded via knownFailedRepoIdsRef — see handleStartClone.
  // Logic mirrors the auto-advance effect above, but for clone_status: 'failed'.
  useEffect(() => {
    if (currentStep !== 'clone' || !loading) return;

    let failedRepo: Repo | undefined;
    for (const [, repo] of repoById) {
      if (repo.clone_status !== 'failed') continue;
      // Skip rows that were already failed when this attempt started — those are
      // stale from a prior attempt and will be replaced by the daemon shortly.
      if (knownFailedRepoIdsRef.current.has(repo.repo_id)) continue;
      if (
        (path === 'assistant' &&
          (repo.slug === FRAMEWORK_REPO_SLUG || repo.remote_url?.includes('agor-assistant'))) ||
        (path === 'own-repo' &&
          ((repoUrl &&
            repo.remote_url &&
            normalizeRepoUrl(repo.remote_url) === normalizeRepoUrl(repoUrl)) ||
            (repoSlug && repo.slug === repoSlug) ||
            (localRepoPath && repo.local_path === localRepoPath)))
      ) {
        failedRepo = repo;
        break;
      }
    }

    if (!failedRepo) return;
    const message =
      failedRepo.clone_error?.message ??
      `Clone failed (exit ${failedRepo.clone_error?.exit_code ?? '?'}).`;
    setLoading(false);
    setError(message);
    if (cloneTimeoutRef.current) {
      clearTimeout(cloneTimeoutRef.current);
      cloneTimeoutRef.current = null;
    }
  }, [currentStep, loading, path, repoById, repoUrl, repoSlug, localRepoPath]);

  // ─── Listen for clone error events from backend ──
  // Two redundant channels because event ordering is not guaranteed and we
  // want whichever lands first to break the spinner:
  //
  //  1. `repo:cloneError` (WebSocket broadcast from `cloneRepository`'s
  //     onExit safety net) — fires only when the executor exits non-zero
  //     and carries a generic, branch-aware message.
  //  2. `repos.patched` (Feathers service event) — fires whenever the
  //     placeholder row transitions to `clone_status: 'failed'`. The patch
  //     payload includes `clone_error.message` (the first line of git's
  //     stderr) which is far more useful than the generic WS message —
  //     e.g. "configuring core.sshCommand is not permitted…" surfaces
  //     verbatim instead of being swallowed into "Clone failed (exit 1)".
  useEffect(() => {
    if (!client?.io) return;

    const isOurCloneByIdentity = (slug: string | undefined, url: string | undefined) =>
      (path === 'assistant' && slug === FRAMEWORK_REPO_SLUG) ||
      (path === 'own-repo' && ((url && url === repoUrl) || (slug && slug === repoSlug)));

    const surfaceError = (message: string) => {
      // Only handle if we're on the clone step and loading. If the user has
      // moved on (or the wizard never reached `'clone'`), don't yank state.
      if (currentStep !== 'clone' || !loading) return;
      setLoading(false);
      setError(message);
      if (cloneTimeoutRef.current) {
        clearTimeout(cloneTimeoutRef.current);
        cloneTimeoutRef.current = null;
      }
    };

    const handleCloneError = (data: { slug: string; url: string; error: string }) => {
      if (!isOurCloneByIdentity(data.slug, data.url)) return;
      surfaceError(data.error);
    };

    const handleRepoPatched = (repo: Repo) => {
      if (repo.clone_status !== 'failed') return;
      if (!isOurCloneByIdentity(repo.slug, repo.remote_url)) return;
      // Prefer the row's specific error; fall back to a generic message.
      const message =
        repo.clone_error?.message ?? `Clone failed (exit ${repo.clone_error?.exit_code ?? '?'}).`;
      surfaceError(message);
    };

    const reposService = client.service('repos');
    client.io.on('repo:cloneError', handleCloneError);
    reposService.on('patched', handleRepoPatched);
    return () => {
      client.io.off('repo:cloneError', handleCloneError);
      reposService.removeListener('patched', handleRepoPatched);
    };
  }, [client, currentStep, loading, path, repoUrl, repoSlug]);

  // Stop elapsed timer when loading stops
  useEffect(() => {
    if (!loading && cloneIntervalRef.current) {
      clearInterval(cloneIntervalRef.current);
      cloneIntervalRef.current = null;
    }
  }, [loading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cloneTimeoutRef.current) {
        clearTimeout(cloneTimeoutRef.current);
      }
      if (cloneIntervalRef.current) {
        clearInterval(cloneIntervalRef.current);
      }
    };
  }, []);

  // ─── Step Handlers ────────────────────────────────

  // Persist onboarding progress to user preferences so restarts can resume.
  // ⚠️  Declared in the handlers section because effects above (notably the
  // createdRepoId-persist effect below) reference it — moving this further
  // down re-introduces a TDZ ReferenceError on mount.
  const saveOnboardingProgress = useCallback(
    (updates: { path?: WizardPath; repoId?: string; boardId?: string; worktreeId?: string }) => {
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

  // Persist createdRepoId so a refresh / reset-then-resume of the wizard
  // lands back on the worktree step with the repo still wired up. Without
  // this, handleCreateWorktree throws "Missing repo or board" on resume
  // because repoId is only kept in local state.
  useEffect(() => {
    if (!createdRepoId) return;
    if (user?.preferences?.onboarding?.repoId === createdRepoId) return;
    saveOnboardingProgress({ repoId: createdRepoId });
  }, [createdRepoId, user, saveOnboardingProgress]);

  const handleSelectPath = useCallback(
    (selectedPath: WizardPath) => {
      setPath(selectedPath);
      setError(null);

      // Persist chosen path immediately
      saveOnboardingProgress({ path: selectedPath });

      // API keys is now the first step for both paths.
      // Check if framework repo already exists (assistant) — if so, skip ahead.
      if (selectedPath === 'assistant') {
        const found = findReadyFrameworkRepo(repoById);
        if (found) {
          setCreatedRepoId(found[0]);
          setCurrentStep('board');
          return;
        }
      }

      setCurrentStep('api-keys');
    },
    [repoById, saveOnboardingProgress, setCurrentStep]
  );

  const handleStartClone = useCallback(async () => {
    // Snapshot which repos are already failed before this attempt starts.
    // The repoById failure watcher ignores these IDs so a stale row from a
    // previous attempt never immediately cancels the new clone.
    const snapshot = new Set<string>();
    for (const [id, repo] of repoById) {
      if (repo.clone_status === 'failed') snapshot.add(id);
    }
    knownFailedRepoIdsRef.current = snapshot;

    setError(null);
    setLoading(true);
    setCloneElapsedSeconds(0);
    // Start elapsed timer
    if (cloneIntervalRef.current) clearInterval(cloneIntervalRef.current);
    cloneIntervalRef.current = setInterval(() => {
      setCloneElapsedSeconds((s) => s + 1);
    }, 1000);

    try {
      if (path === 'assistant') {
        await onCreateRepo({
          url: effectiveFrameworkUrl,
          slug: FRAMEWORK_REPO_SLUG,
          default_branch: 'main',
        });
      } else {
        // If the user typed a local filesystem path into the URL field (starts with
        // / or ~), treat it as a local repo regardless of which mode toggle is active.
        const looksLikeLocalPath = repoUrl.startsWith('/') || repoUrl.startsWith('~');
        const effectiveMode = looksLikeLocalPath ? 'local' : repoMode;

        if (effectiveMode === 'remote') {
          await onCreateRepo({
            url: repoUrl,
            slug: repoSlug || '',
            default_branch: 'main',
          });
        } else {
          // Local repos are registered synchronously — no clone needed.
          await onCreateLocalRepo({
            path: looksLikeLocalPath ? repoUrl : localRepoPath,
            slug: repoSlug || undefined,
          });
        }
      }
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    // Decide whether this operation is async (clone) or synchronous (local registration).
    const looksLikeLocalPath = repoUrl.startsWith('/') || repoUrl.startsWith('~');
    const effectiveMode = path === 'own-repo' && looksLikeLocalPath ? 'local' : repoMode;
    const isAsyncClone =
      path === 'assistant' || (path === 'own-repo' && effectiveMode === 'remote');

    // Transition to the clone step so the auto-advance effect can detect
    // the newly-created repo in repoById and move to the board step.
    // For assistant path, we're already on 'clone' (auto-triggered).
    // For local repos, registration is synchronous — skip the clone step entirely.
    if (path === 'own-repo') {
      if (isAsyncClone) {
        setCurrentStep('clone');
      } else {
        if (cloneIntervalRef.current) {
          clearInterval(cloneIntervalRef.current);
          cloneIntervalRef.current = null;
        }
        setLoading(false);
        setCurrentStep('board');
      }
    }

    // Set timeout for async clone completion only.
    if (isAsyncClone) {
      cloneTimeoutRef.current = setTimeout(() => {
        setLoading(false);
        setError(
          'Clone is taking too long. This could be due to network issues, an unreachable repository, or a missing GITHUB_TOKEN for private repos. Please check and try again.'
        );
      }, CLONE_TIMEOUT_MS);
    }
  }, [
    path,
    effectiveFrameworkUrl,
    repoMode,
    repoUrl,
    repoSlug,
    localRepoPath,
    repoById,
    onCreateRepo,
    onCreateLocalRepo,
    setCurrentStep,
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
  }, [client, user, boardById, saveOnboardingProgress, setCurrentStep]);

  const handleCreateWorktree = useCallback(async () => {
    if (!createdRepoId || !createdBoardId) {
      setError('Missing repo or board. Please go back and try again.');
      return;
    }

    setError(null);
    setLoading(true);

    // Worktree name and ref are unified into a single input — they're almost
    // always the same for first-time users, and the underlying form elsewhere
    // exposes the same shortcut.
    const sanitized = sanitizeBranchName(branchName);
    // Fork from the repo's actual default branch (e.g. 'master' on older
    // repos), falling back to 'main' for legacy rows missing the field.
    const sourceBranch = repoById.get(createdRepoId)?.default_branch || 'main';

    try {
      const worktree = await onCreateWorktree(createdRepoId, {
        name: sanitized,
        ref: sanitized,
        createBranch: true,
        sourceBranch,
        pullLatest: true,
        boardId: createdBoardId,
      });

      if (worktree) {
        setCreatedWorktreeId(worktree.worktree_id);
        // Persist worktree ID so restarts don't re-create it
        saveOnboardingProgress({ worktreeId: worktree.worktree_id });

        // Tag assistant worktrees
        if (path === 'assistant' && onUpdateWorktree) {
          const assistantConfig: AssistantConfig = {
            kind: 'assistant',
            displayName: 'My Assistant',
            frameworkRepo: FRAMEWORK_REPO_SLUG,
            createdViaOnboarding: true,
          };
          await onUpdateWorktree(worktree.worktree_id, {
            custom_context: { ...worktree.custom_context, assistant: assistantConfig },
          });
        }

        setLoading(false);
        setCurrentStep('launch');
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
    branchName,
    repoById,
    onCreateWorktree,
    onUpdateWorktree,
    saveOnboardingProgress,
    setCurrentStep,
  ]);

  const handleSaveApiKey = useCallback(async () => {
    if (!user || !apiKey.trim()) return;

    setError(null);
    setLoading(true);

    try {
      // Persist into the per-tool credential bucket. Field name = env var name
      // = ANTHROPIC_API_KEY / OPENAI_API_KEY / etc., as `apiKeyNameForAgent`
      // returns. The `selectedAgent` IS the bucket — except for `opencode`,
      // which is a multi-provider tool with no canonical credential of its
      // own (`OpencodeConfig` has no fields). The onboarding fallback for
      // opencode collects an Anthropic key, so we route it to claude-code's
      // bucket where it's modeled, surfaced in settings, and resolvable.
      const keyName = apiKeyNameForAgent(selectedAgent);
      const targetTool: AgenticToolName =
        selectedAgent === 'opencode' ? 'claude-code' : selectedAgent;
      await onUpdateUser(user.user_id, {
        agentic_tools: {
          [targetTool]: { [keyName]: apiKey.trim() },
        } as UpdateUserInput['agentic_tools'],
      });
      setLoading(false);
      setCurrentStep(path === 'own-repo' ? 'add-repo' : 'clone');
    } catch (err) {
      setLoading(false);
      setError(`Failed to save API key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [user, apiKey, selectedAgent, path, onUpdateUser, setCurrentStep]);

  const handleAdvanceFromApiKeys = useCallback(() => {
    setCurrentStep(path === 'own-repo' ? 'add-repo' : 'clone');
  }, [path, setCurrentStep]);

  const handleTestAuth = useCallback(async () => {
    if (!onCheckAuth) return;
    setTestAuthLoading(true);
    setTestAuthResult(null);
    const result = await onCheckAuth(selectedAgent, apiKey.trim() || undefined);
    setTestAuthLoading(false);
    setTestAuthResult(result);
  }, [onCheckAuth, selectedAgent, apiKey]);

  const handleLaunch = useCallback(async () => {
    if (!createdWorktreeId || !createdBoardId || !path) {
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
          ...(path === 'assistant' && { initialPrompt: ASSISTANT_BOOT_PROMPT }),
        },
        createdBoardId
      );

      if (sessionId) {
        setLoading(false);
        onComplete({ worktreeId: createdWorktreeId, sessionId, boardId: createdBoardId, path });
      } else {
        setLoading(false);
        setError('Failed to create session. Please try again.');
      }
    } catch (err) {
      setLoading(false);
      setError(`Failed to launch session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [createdWorktreeId, createdBoardId, selectedAgent, path, onCreateSession, onComplete]);

  const handleSkip = useCallback(() => {
    if (!user) return;
    // onComplete sets onboarding_completed; updating it here too would double-PATCH.
    onComplete({
      worktreeId: '',
      sessionId: '',
      boardId: '',
      path: 'assistant',
    });
  }, [user, onComplete]);

  const handleBack = useCallback(() => {
    setError(null);
    const idx = stepIndex;
    if (idx > 0) {
      setCurrentStep(steps[idx - 1]);
    }
  }, [stepIndex, steps, setCurrentStep]);

  // Dev-only: reset the wizard back to the welcome screen so the flows can be
  // re-tested without DB surgery. Clears persisted onboarding state but leaves
  // any repos / boards / worktrees the user already created intact — those
  // are easy to clean up manually if needed.
  const handleReset = useCallback(async () => {
    if (cloneTimeoutRef.current) {
      clearTimeout(cloneTimeoutRef.current);
      cloneTimeoutRef.current = null;
    }
    if (cloneIntervalRef.current) {
      clearInterval(cloneIntervalRef.current);
      cloneIntervalRef.current = null;
    }
    setPath(null);
    setCurrentStep('welcome');
    setError(null);
    setLoading(false);
    setRepoUrl('');
    setRepoSlug('');
    setLocalRepoPath('');
    setRepoMode('remote');
    setBranchName('');
    setApiKey('');
    setSelectedAgent('claude-code');
    setTestAuthLoading(false);
    setTestAuthResult(null);
    setOverrideDetectedAuth(false);
    setCreatedRepoId(null);
    setCreatedBoardId(null);
    setCreatedWorktreeId(null);
    setCloneElapsedSeconds(0);
    resumedRef.current = false;
    branchNameInitRef.current = false;
    autoTestedAgentRef.current = null;
    knownFailedRepoIdsRef.current = new Set();

    if (user) {
      const prefs = { ...(user.preferences || {}) } as Record<string, unknown>;
      delete prefs.onboarding;
      delete prefs.mainBoardId;
      await onUpdateUser(user.user_id, { preferences: prefs as UserPreferences });
    }
  }, [user, onUpdateUser, setCurrentStep]);

  // ─── Render Helpers ───────────────────────────────

  const renderWelcome = () => (
    <div style={{ padding: '8px 0' }}>
      <Title level={3} style={{ marginBottom: 6 }}>
        Welcome to Agor
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24, fontSize: 15 }}>
        Let's get you set up with your first AI session.
      </Paragraph>

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card
          hoverable
          onClick={() => handleSelectPath('assistant')}
          style={{ cursor: 'pointer', borderColor: token.colorPrimary }}
        >
          <Space align="start" size="middle">
            <ThunderboltOutlined
              style={{ fontSize: 24, color: token.colorPrimary, marginTop: 2, flexShrink: 0 }}
            />
            <div>
              <Space style={{ marginBottom: 6 }} align="center">
                <Text strong style={{ fontSize: 15 }}>
                  Set up your AI assistant
                </Text>
                <Tag color="blue">Recommended</Tag>
              </Space>
              <Paragraph type="secondary" style={{ marginBottom: 6 }}>
                Get a persistent AI assistant with memory, task management, and pre-configured
                workflows.
              </Paragraph>
              <Text type="secondary" style={{ fontSize: 12 }}>
                API key → Clone assistant framework → Board → Worktree → Launch
              </Text>
            </div>
          </Space>
        </Card>

        <Card hoverable onClick={() => handleSelectPath('own-repo')} style={{ cursor: 'pointer' }}>
          <Space align="start" size="middle">
            <FolderOpenOutlined
              style={{
                fontSize: 24,
                color: token.colorTextSecondary,
                marginTop: 2,
                flexShrink: 0,
              }}
            />
            <div>
              <Text strong style={{ fontSize: 15 }}>
                Bring your own repository
              </Text>
              <Paragraph type="secondary" style={{ marginBottom: 6, marginTop: 4 }}>
                Connect an existing Git repository and start coding with AI agents.
              </Paragraph>
              <Text type="secondary" style={{ fontSize: 12 }}>
                API key → Add repository → Board → Worktree → Launch
              </Text>
            </div>
          </Space>
        </Card>
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
              onChange={(e) => {
                const value = e.target.value;
                setRepoUrl(value);
                // Mirror RepoFormFields: auto-fill slug from URL on every keystroke.
                // `looksLikeLocalPath` covers the case where the user pastes a
                // filesystem path into the URL field (handled downstream too).
                if (!value) return;
                try {
                  const looksLikeLocalPath = value.startsWith('/') || value.startsWith('~');
                  const slug = looksLikeLocalPath
                    ? extractSlugFromPath(value)
                    : extractSlugFromUrl(value);
                  if (slug) setRepoSlug(slug);
                } catch {
                  // Partial/invalid URL while typing — leave the slug untouched.
                }
              }}
            />
          </Form.Item>
          <Form.Item
            label="Slug (optional)"
            validateStatus={repoSlug && !isValidSlug(repoSlug) ? 'error' : ''}
            help={
              repoSlug && !isValidSlug(repoSlug)
                ? 'Must be org/name format (e.g. "my-org/my-repo")'
                : undefined
            }
            extra="Auto-detected from URL (editable)"
          >
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
              onChange={(e) => {
                const value = e.target.value;
                setLocalRepoPath(value);
                if (!value) return;
                const slug = extractSlugFromPath(value);
                if (slug) setRepoSlug(slug);
              }}
            />
          </Form.Item>
          <Form.Item
            label="Slug (optional)"
            validateStatus={repoSlug && !isValidSlug(repoSlug) ? 'error' : ''}
            help={
              repoSlug && !isValidSlug(repoSlug)
                ? 'Must be org/name format (e.g. "my-org/my-repo")'
                : undefined
            }
            extra="Auto-detected from path (editable)"
          >
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
            {path === 'assistant'
              ? 'Cloning assistant framework...'
              : 'Setting up your repository...'}
          </Paragraph>
          <Text type="secondary">
            {cloneElapsedSeconds < 10
              ? 'This may take a moment'
              : cloneElapsedSeconds < 30
                ? `Cloning in progress... (${cloneElapsedSeconds}s)`
                : `Still working... large repos can take a while (${cloneElapsedSeconds}s)`}
          </Text>
        </>
      ) : error ? (
        <>
          <Alert
            type="error"
            title="Clone failed"
            description={error}
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
              path === 'assistant'
                ? 'Assistant framework cloned successfully.'
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
            title={error}
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

  const renderWorktree = () => {
    const sourceBranch =
      (createdRepoId ? repoById.get(createdRepoId)?.default_branch : null) || 'main';
    return (
      <div style={{ padding: '16px 0' }}>
        <Title level={4}>Create Your Worktree</Title>
        <Paragraph type="secondary">
          A worktree is an isolated copy of your repo with its own branch.
          {path === 'assistant'
            ? " We'll set up a worktree for your assistant."
            : ' Name it whatever you like.'}
        </Paragraph>

        <Form layout="vertical">
          <Form.Item
            label="Worktree / branch name"
            extra={
              <>
                Used as both the directory name and the new branch name. Forked from{' '}
                <Text code>{sourceBranch}</Text>.
              </>
            }
          >
            <Input
              placeholder={`private-${usernameSlug}`}
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
            />
          </Form.Item>
        </Form>

        {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}

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
  };

  const renderApiKeys = () => {
    const hasKey = hasKeyForAgent(selectedAgent);
    // "Already auth'd" covers both stored credentials (agentic_tools / env vars
    // / system credentials) AND ambient CLI auth detected by onCheckAuth —
    // e.g. the user already ran `claude auth login` outside the wizard.
    const isAuthenticated = hasKey || !!testAuthResult?.authenticated;

    const renderAuthHint = () => {
      if (selectedAgent === 'claude-code') {
        return (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16, textAlign: 'left' }}
            description={
              <span>
                You have three ways to authenticate Claude Code: paste an{' '}
                <Text code style={{ fontSize: 12 }}>
                  ANTHROPIC_API_KEY
                </Text>{' '}
                below, run{' '}
                <Text code style={{ fontSize: 12 }}>
                  claude auth login
                </Text>{' '}
                in the terminal Agor runs as, or set up a Pro/Max session token from{' '}
                <Text strong>User Settings → Claude Code</Text> (best for Claude subscribers).
              </span>
            }
          />
        );
      }
      if (selectedAgent === 'codex') {
        return (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16, textAlign: 'left' }}
            description={
              <span>
                Paste an{' '}
                <Text code style={{ fontSize: 12 }}>
                  OPENAI_API_KEY
                </Text>{' '}
                below, or authenticate via{' '}
                <Text code style={{ fontSize: 12 }}>
                  codex
                </Text>{' '}
                in the terminal Agor runs as.
              </span>
            }
          />
        );
      }
      if (AGENT_KEY_CONSOLES[selectedAgent]) {
        return (
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            Paste your {apiKeyNameForAgent(selectedAgent)} below. Get one at{' '}
            <Typography.Link
              href={AGENT_KEY_CONSOLES[selectedAgent]?.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {AGENT_KEY_CONSOLES[selectedAgent]?.label}
            </Typography.Link>
            .
          </Paragraph>
        );
      }
      return null;
    };

    return (
      <div style={{ padding: '16px 0' }}>
        <Title level={4}>Configure Your Agent</Title>

        <Form layout="vertical">
          <Form.Item label="Agent">
            <Select
              value={selectedAgent}
              onChange={(value) => {
                setSelectedAgent(value);
                setApiKey('');
                setError(null);
                setTestAuthResult(null);
                setOverrideDetectedAuth(false);
              }}
              options={[
                { value: 'claude-code', label: 'Claude Code (Recommended)' },
                { value: 'codex', label: 'Codex (OpenAI)' },
                { value: 'gemini', label: 'Gemini' },
                { value: 'copilot', label: 'GitHub Copilot' },
                { value: 'opencode', label: 'OpenCode' },
              ]}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Form>

        {testAuthLoading && !testAuthResult ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <Spin />
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              Checking authentication…
            </Paragraph>
          </div>
        ) : isAuthenticated && !overrideDetectedAuth ? (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <Result
              style={{ padding: '16px 0' }}
              icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
              title={
                hasKey
                  ? `${AGENT_LABELS[selectedAgent]} is configured`
                  : `Already authenticated${testAuthResult?.method ? ` (${testAuthResult.method})` : ''}`
              }
              subTitle={
                testAuthResult?.hint || `You're all set to use ${AGENT_LABELS[selectedAgent]}.`
              }
            />
            <Space direction="vertical" size="small">
              <Button type="primary" onClick={handleAdvanceFromApiKeys}>
                Continue
              </Button>
              {/* Escape hatch: detected auth may be stale, wrong-account, or
                  just not what the user wants (e.g. ChatGPT OAuth detected
                  but they prefer a work API key). */}
              <Button type="link" onClick={() => setOverrideDetectedAuth(true)}>
                Use a different API key instead
              </Button>
            </Space>
          </div>
        ) : (
          <>
            {isAuthenticated && overrideDetectedAuth && (
              <div style={{ marginBottom: 12 }}>
                <Button
                  type="link"
                  onClick={() => {
                    setOverrideDetectedAuth(false);
                    setApiKey('');
                  }}
                  style={{ padding: 0 }}
                >
                  ← Back to detected authentication
                </Button>
              </div>
            )}
            {renderAuthHint()}

            {selectedAgent === 'opencode' && (
              <Paragraph type="secondary" style={{ marginBottom: 16 }}>
                OpenCode supports 75+ LLM providers. Configure the appropriate API key for your
                chosen provider below.
              </Paragraph>
            )}

            <Form layout="vertical">
              <Form.Item label={apiKeyNameForAgent(selectedAgent)}>
                <Input.Password
                  placeholder={apiKeyPlaceholder(selectedAgent)}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </Form.Item>
            </Form>

            {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}

            {testAuthResult && !testAuthResult.authenticated && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16, textAlign: 'left' }}
                title="Not authenticated"
                description={testAuthResult.hint}
              />
            )}

            <Space wrap>
              <Button
                type="primary"
                onClick={handleSaveApiKey}
                loading={loading}
                disabled={!apiKey.trim()}
                icon={<KeyOutlined />}
              >
                Save & Continue
              </Button>
              {onCheckAuth && (
                <Button onClick={handleTestAuth} loading={testAuthLoading} disabled={loading}>
                  Test Connection
                </Button>
              )}
              <Button onClick={handleAdvanceFromApiKeys} disabled={loading}>
                Continue without key
              </Button>
            </Space>
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Keys are saved to{' '}
                <Text strong style={{ fontSize: 12 }}>
                  User Settings → Agent Setup
                </Text>{' '}
                — you can update them any time.
              </Text>
            </div>
          </>
        )}
      </div>
    );
  };

  const renderLaunch = () => (
    <div style={{ textAlign: 'center', padding: '24px 0' }}>
      <Title level={4}>Ready to Launch</Title>
      <Paragraph type="secondary">
        {path === 'assistant'
          ? "Your assistant is set up. Let's create your first session!"
          : "Your worktree is ready. Let's launch a session!"}
      </Paragraph>

      {error && (
        <Alert
          type="error"
          title={error}
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
        Launch Session
      </Button>
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
    // Don't include 'welcome' in the steps indicator. For own-repo, also hide
    // 'clone' since it's visually merged with 'add-repo' (both labelled "Repo").
    // For assistant there's no 'add-repo' step, so keep 'clone' visible —
    // otherwise the indicator jumps straight to "Board" while the framework
    // is still cloning.
    const displaySteps = allSteps.filter(
      (s) => s !== 'welcome' && !(path === 'own-repo' && s === 'clone')
    );

    const labelMap: Record<WizardStep, string> = {
      welcome: 'Welcome',
      'add-repo': 'Repo',
      clone: path === 'own-repo' ? 'Repo' : 'Clone',
      board: 'Board',
      worktree: 'Worktree',
      'api-keys': 'Keys',
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
    // Mirror the filter used by stepsItems: hide 'clone' only for own-repo,
    // where it's merged into 'add-repo'. Assistant keeps its 'clone' step.
    const displaySteps = getStepsForPath(path).filter(
      (s) => s !== 'welcome' && !(path === 'own-repo' && s === 'clone')
    );
    // For own-repo, map the internal 'clone' state onto the merged 'add-repo' index.
    const mappedStep = currentStep === 'clone' && path === 'own-repo' ? 'add-repo' : currentStep;
    return displaySteps.indexOf(mappedStep);
  }, [path, currentStep]);

  // ─── Auto-trigger steps that should auto-start ────
  useEffect(() => {
    // Auto-start clone when entering clone step for assistant
    if (currentStep === 'clone' && path === 'assistant' && !loading && !error && !createdRepoId) {
      handleStartClone();
    }
  }, [currentStep, path, loading, error, createdRepoId, handleStartClone]);

  // Auto-start board creation
  useEffect(() => {
    if (currentStep === 'board' && !loading && !error && !createdBoardId) {
      handleCreateBoard();
    }
  }, [currentStep, loading, error, createdBoardId, handleCreateBoard]);

  // Reset auto-test tracker when leaving the api-keys step so the next
  // visit can re-test (e.g. after the user installs a CLI auth elsewhere).
  useEffect(() => {
    if (currentStep !== 'api-keys') {
      autoTestedAgentRef.current = null;
    }
  }, [currentStep]);

  // Auto-run a connection test when the user lands on api-keys (or switches
  // agents on it). This catches the common case where they've already auth'd
  // the agent CLI (e.g. `claude auth login`) — surfaces a Continue button
  // instead of asking for a key they don't need.
  useEffect(() => {
    if (currentStep !== 'api-keys' || !onCheckAuth) return;
    if (autoTestedAgentRef.current === selectedAgent) return;
    autoTestedAgentRef.current = selectedAgent;
    setTestAuthResult(null);
    setTestAuthLoading(true);
    onCheckAuth(selectedAgent)
      .then((result) => setTestAuthResult(result))
      .catch(() => {})
      .finally(() => setTestAuthLoading(false));
  }, [currentStep, selectedAgent, onCheckAuth]);

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
        <Typography.Link
          href="https://agor.live/guide/getting-started"
          target="_blank"
          style={{ fontSize: 12 }}
        >
          Getting Started Docs
        </Typography.Link>
        <Typography.Link
          href="https://github.com/preset-io/agor"
          target="_blank"
          style={{ fontSize: 12 }}
        >
          GitHub
        </Typography.Link>
      </Space>

      {/* Right: Dev reset + Skip */}
      <Space size="small">
        {import.meta.env.DEV && (
          <Popconfirm
            title="Reset wizard?"
            description={
              <div style={{ maxWidth: 280 }}>
                Clears local state and onboarding progress in your user preferences. Repos, boards,
                and worktrees you created stay put.
              </div>
            }
            okText="Reset"
            cancelText="Cancel"
            onConfirm={handleReset}
          >
            <Button type="text" size="small" style={{ color: token.colorTextTertiary }}>
              Reset (dev)
            </Button>
          </Popconfirm>
        )}
        <Popconfirm
          title="Skip setup?"
          description={
            <div style={{ maxWidth: 250 }}>
              Are you sure? Your assistant has been waiting their whole life to meet you.
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

  // ─── Render ───────────────────────────────────────

  return (
    <Modal
      open={open}
      closable={false}
      mask={{ closable: false }}
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
      {currentStep !== 'welcome' && stepIndex > 1 && !loading && (
        <div style={{ marginTop: 16 }}>
          <Button type="link" onClick={handleBack} style={{ padding: 0 }}>
            &larr; Back
          </Button>
        </div>
      )}
    </Modal>
  );
}
