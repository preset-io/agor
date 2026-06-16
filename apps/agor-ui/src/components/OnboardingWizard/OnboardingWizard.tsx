/**
 * OnboardingWizard - Multi-step wizard for new user onboarding
 *
 * Assistant-first path:
 * - Assistant: identity -> API keys -> clone assistant framework repo -> create board -> create branch/session
 *
 * Replaces GettingStartedPopover entirely.
 */

import type {
  AgenticToolName,
  AssistantConfig,
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
import {
  extractSlugFromUrl,
  isValidSlug,
  normalizeRepoUrl,
  TOOL_API_KEY_NAMES,
} from '@agor-live/client';
import {
  ApiOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  RobotOutlined,
} from '@ant-design/icons';
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
import { buildAssistantBootstrapPrompt } from '../../utils/assistantBootstrapPrompt';
import { ensureAssistantWelcomeNote } from '../../utils/assistantWelcomeNote';
import { extractSlugFromPath, slugify } from '../../utils/repoSlug';
import { startAssistantBootstrapSession } from '../../utils/startAssistantBootstrapSession';
import { EmojiPickerInput } from '../EmojiPickerInput/EmojiPickerInput';
import type { NewSessionConfig } from '../NewSessionModal/NewSessionModal';
import { ToolIcon } from '../ToolIcon';

const { Text, Title, Paragraph } = Typography;
const { useToken } = theme;

// ─── Constants ──────────────────────────────────────────

const CLONE_TIMEOUT_MS = 120_000;

// ─── Types ──────────────────────────────────────────────

type WizardPath = 'assistant' | 'own-repo';

type WizardStep = 'welcome' | 'identity' | 'add-repo' | 'clone' | 'board' | 'branch' | 'api-keys';

type AuthMethod = 'api-key' | 'claude-subscription-token' | 'codex-cli-auth';

export interface OnboardingWizardProps {
  open: boolean;
  onComplete: (result: {
    branchId: string;
    sessionId: string;
    boardId: string;
    path: WizardPath;
  }) => void;

  // Data
  repoById: Map<string, Repo>;
  branchById: Map<string, Branch>;
  boardById: Map<string, Board>;
  user?: User | null;
  // biome-ignore lint/suspicious/noExplicitAny: AgorClient type varies
  client: any;

  // Actions
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

  // Config from health endpoint
  assistantPending?: boolean;
  frameworkRepoUrl?: string;
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
    return ['welcome', 'identity', 'api-keys', 'clone', 'board', 'branch'];
  }
  if (path === 'own-repo') {
    return ['welcome', 'api-keys', 'add-repo', 'clone', 'board', 'branch'];
  }
  return ['welcome'];
}

function getStepIndex(steps: WizardStep[], step: WizardStep): number {
  return steps.indexOf(step);
}

function apiKeyNameForAgent(agent: AgenticToolName, authMethod: AuthMethod = 'api-key'): string {
  if (agent === 'claude-code' && authMethod === 'claude-subscription-token') {
    return 'CLAUDE_CODE_OAUTH_TOKEN';
  }
  // opencode has no canonical key of its own; wizard collects an Anthropic key
  // and routes it to the claude-code bucket (see handleSaveApiKey).
  return TOOL_API_KEY_NAMES[agent] ?? 'ANTHROPIC_API_KEY';
}

function apiKeyPlaceholder(agent: AgenticToolName, authMethod: AuthMethod = 'api-key'): string {
  if (agent === 'claude-code' && authMethod === 'claude-subscription-token') {
    return 'sk-ant-oat01-...';
  }
  switch (agent) {
    case 'claude-code':
      return 'sk-ant-...';
    case 'codex':
      return 'sk-...';
    case 'gemini':
      return 'AIza...';
    case 'copilot':
      return 'ghp_...';
    case 'cursor':
      return 'key_...';
    default:
      return 'sk-ant-...';
  }
}

const AGENT_LABELS: Record<AgenticToolName, string> = {
  'claude-code': 'Claude Code',
  'claude-code-cli': 'Claude Code CLI',
  codex: 'Codex (OpenAI)',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor SDK',
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
 * Used by both the clone-complete auto-advance effect and the board/branch
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

const RECOMMENDED_AGENT_OPTIONS: Array<{
  value: AgenticToolName;
  title: string;
  eyebrow: string;
}> = [
  {
    value: 'claude-code',
    title: 'Claude Code',
    eyebrow: 'Recommended',
  },
  {
    value: 'codex',
    title: 'Codex',
    eyebrow: 'Recommended',
  },
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
  // Claude Code CLI uses the same Anthropic credentials.
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
  return agent === 'codex' ? 'codex-cli-auth' : 'api-key';
}

function authMethodOptionsForAgent(agent: AgenticToolName) {
  if (agent === 'claude-code') {
    return [
      {
        value: 'claude-subscription-token' as const,
        label: 'Subscription',
      },
      {
        value: 'api-key' as const,
        label: 'API key',
      },
    ];
  }

  if (agent === 'codex') {
    return [
      {
        value: 'codex-cli-auth' as const,
        label: 'CLI sign-in',
      },
      {
        value: 'api-key' as const,
        label: 'API key',
      },
    ];
  }

  return null;
}

// ─── Component ──────────────────────────────────────────

export function OnboardingWizard({
  open,
  onComplete,
  repoById,
  branchById,
  boardById,
  user,
  client,
  onCreateRepo,
  onCreateLocalRepo,
  onCreateBranch,
  onCreateSession,
  onUpdateUser,
  onCheckAuth,
  assistantPending,
  frameworkRepoUrl,
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
  const [assistantDisplayName, setAssistantDisplayName] = useState('My Assistant');
  const [assistantEmoji, setAssistantEmoji] = useState('🤖');
  const [apiKey, setApiKey] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('api-key');
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>('claude-code');
  const [lastRecommendedAgent, setLastRecommendedAgent] = useState<AgenticToolName>('claude-code');
  const [useDifferentProvider, setUseDifferentProvider] = useState(false);
  const [testAuthLoading, setTestAuthLoading] = useState(false);
  // Inline feedback from the user clicking "Test Connection" on a typed key.
  // Never flips the panel, never advances, never saves. Wiped on agent
  // change and on key edit (stale).
  const [manualTestResult, setManualTestResult] = useState<AuthCheckResult | null>(null);
  // Lets the user opt out of an already-stored per-user credential and paste
  // a different key — useful when the stored key is wrong-account or stale.
  // Resets on agent change and on wizard reset.
  const [overrideDetectedAuth, setOverrideDetectedAuth] = useState(false);

  // Created resource IDs
  const [createdRepoId, setCreatedRepoId] = useState<string | null>(null);
  const [createdBoardId, setCreatedBoardId] = useState<string | null>(null);
  const [createdBranchId, setCreatedBranchId] = useState<string | null>(null);

  // Timeout ref for clone
  const cloneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Elapsed time for clone progress
  const [cloneElapsedSeconds, setCloneElapsedSeconds] = useState(0);
  const cloneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Repo IDs that were already failed when the current clone attempt started.
  // The failure watcher ignores these so a stale row from a prior attempt never
  // immediately cancels a new retry before the daemon has a chance to replace it.
  const knownFailedRepoIdsRef = useRef<Set<string>>(new Set());

  // ─── Derived ──────────────────────────────────────
  const steps = useMemo(() => getStepsForPath(path), [path]);
  const stepIndex = getStepIndex(steps, currentStep);
  const usernameSlug = getUsernameSlug(user);
  const effectiveFrameworkUrl = frameworkRepoUrl || FRAMEWORK_REPO_URL;

  // Claude Code accepts either an Anthropic API key or a Pro/Max subscription
  // OAuth token (from `claude setup-token`). Either is a valid credential.
  // Per-tool credentials live under `agentic_tools[tool][envVarName]` (boolean
  // presence flags on the public DTO). `env_vars` is also per-user (lives on
  // the User record).
  //
  // Intentionally PER-USER only — we don't consider host-level fallbacks
  // (config.yaml `credentials.*` or daemon process env vars) when deciding
  // whether to skip the LLM-auth onboarding step. Sessions still fall back
  // to host-level creds at run time, but treating them as "this user is
  // already authenticated" auto-skipped onboarding for brand-new users (they
  // silently inherited the admin's setup with no chance to configure their
  // own). Users who want the host fallback can click "Continue without key"
  // in the form.
  const claudeFields = user?.agentic_tools?.['claude-code'];
  const codexFields = user?.agentic_tools?.codex;
  const geminiFields = user?.agentic_tools?.gemini;
  const copilotFields = user?.agentic_tools?.copilot;
  const cursorFields = user?.agentic_tools?.cursor;
  const hasAnthropicKey = !!(
    claudeFields?.ANTHROPIC_API_KEY ||
    claudeFields?.CLAUDE_CODE_OAUTH_TOKEN ||
    user?.env_vars?.ANTHROPIC_API_KEY
  );
  const hasOpenAIKey = !!(codexFields?.OPENAI_API_KEY || user?.env_vars?.OPENAI_API_KEY);
  const hasGeminiKey = !!(geminiFields?.GEMINI_API_KEY || user?.env_vars?.GEMINI_API_KEY);
  const hasCopilotToken = !!(
    copilotFields?.COPILOT_GITHUB_TOKEN || user?.env_vars?.COPILOT_GITHUB_TOKEN
  );
  const hasCursorKey = !!(cursorFields?.CURSOR_API_KEY || user?.env_vars?.CURSOR_API_KEY);

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
      case 'cursor':
        return hasCursorKey;
      case 'opencode':
        return hasAnthropicKey || hasOpenAIKey || hasGeminiKey;
      default:
        return false;
    }
  };

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
      if (RECOMMENDED_AGENT_VALUES.has(agent)) {
        setLastRecommendedAgent(agent);
      }
      setUseDifferentProvider(options.useDifferentProvider ?? !RECOMMENDED_AGENT_VALUES.has(agent));
      resetProviderAuthState();
    },
    [resetProviderAuthState]
  );

  // ─── Resume from prior onboarding state ──────────
  //
  // ONE-SHOT: this effect runs exactly once per wizard mount, before any
  // user interaction. The wizard's own `saveOnboardingProgress` writes the
  // user-selected path back to `user.preferences.onboarding.path`, which
  // would otherwise cause this effect to re-fire AFTER the user picks a
  // path — making a fresh-flow user look like a returning-resumption user
  // and triggering bogus step jumps (e.g. the assistant-path branch picks
  // up the SHARED framework repo and skips to "board", silently bypassing
  // api-keys and clone). resumedRef.current is set unconditionally at the
  // end so subsequent re-renders are no-ops. Wizard remount on user
  // change (key={currentUser.user_id} in App.tsx) gives each user a fresh
  // shot at the resume decision.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (!open || resumedRef.current || !user) return;
    resumedRef.current = true;

    const onboarding = user.preferences?.onboarding;
    const mainBoardId = user.preferences?.mainBoardId;

    if (!onboarding?.path) {
      // No prior state — auto-select assistant path if flag was set (e.g. by existing installs)
      if (assistantPending && !path) {
        setPath('assistant');
      }
      return;
    }

    // Only the assistant path remains an active onboarding route. Legacy saved
    // non-assistant path preferences are allowed to keep their data shape, but
    // they resume at the assistant flow instead of exposing the old path.
    const savedPath = onboarding.path === 'persisted-agent' ? 'assistant' : onboarding.path;
    const canResumeAssistantResources = savedPath === 'assistant';

    // Resource-ownership validation. The resume-step decisions below jump the
    // wizard past the api-keys / board / repo creation steps based on IDs
    // stored in user.preferences. If those IDs ever point at resources NOT
    // created by the current user — whether through a leak, a stale prefs
    // copy, or an admin viewing a shared resource — the wizard would
    // wrongly skip steps for a user who hasn't actually completed them.
    // Only treat the resume IDs as valid when (a) the resource is loaded
    // AND (b) the current user is its creator. Anything that fails this
    // check is treated as if the preference were unset; the fallback chain
    // then routes the user to the right step (typically api-keys).
    const validBranchId =
      canResumeAssistantResources &&
      onboarding.branchId &&
      branchById.get(onboarding.branchId)?.created_by === user.user_id
        ? onboarding.branchId
        : undefined;
    const validBoardId =
      canResumeAssistantResources &&
      mainBoardId &&
      boardById.get(mainBoardId)?.created_by === user.user_id
        ? mainBoardId
        : undefined;
    // Repos are SHARED resources (no created_by attribution). We require a
    // saved repoId in the user's own preferences as proof that this user
    // intentionally adopted this repo — we deliberately do NOT pick up
    // matching repos from the map otherwise (e.g. via findReadyFrameworkRepo)
    // as that would let a new user inherit any framework repo cloned by a
    // prior user and skip the clone step.
    const validRepoId =
      canResumeAssistantResources && onboarding.repoId && repoById.has(onboarding.repoId)
        ? onboarding.repoId
        : undefined;

    if (
      onboarding.branchId !== validBranchId ||
      mainBoardId !== validBoardId ||
      onboarding.repoId !== validRepoId
    ) {
      console.warn('[OnboardingWizard] Dropping resume references not owned by current user', {
        user_id: user.user_id,
        claimed: { branchId: onboarding.branchId, mainBoardId, repoId: onboarding.repoId },
        valid: { branchId: validBranchId, boardId: validBoardId, repoId: validRepoId },
      });
    }

    // Map every saved onboarding path to the assistant flow. 'persisted-agent'
    // is the old assistant path name; 'own-repo' is no longer an onboarding path.
    const resumedPath: WizardPath = 'assistant';
    setPath(resumedPath);

    if (resumedPath === 'assistant') {
      if (typeof onboarding.assistantDisplayName === 'string') {
        setAssistantDisplayName(onboarding.assistantDisplayName);
        setBranchName(`private-${slugify(onboarding.assistantDisplayName || 'My Assistant')}`);
      }
      if (typeof onboarding.assistantEmoji === 'string') {
        setAssistantEmoji(onboarding.assistantEmoji);
      }
    }

    // Restore created resource IDs (only the validated ones)
    if (validBoardId) {
      setCreatedBoardId(validBoardId);
    }

    // Restore repoId so the branch step doesn't fail "Missing repo or board"
    // on resume.
    if (validRepoId) {
      setCreatedRepoId(validRepoId);
    }

    if (validBranchId) {
      setCreatedBranchId(validBranchId);
    }

    // Figure out which step to resume from
    if (validBranchId) {
      // Branch exists AND is owned by current user — stay on the branch
      // step, which can retry launching the first session inline.
      setCurrentStep('branch');
    } else if (validBoardId) {
      // Board exists AND is owned by current user — go to branch creation
      setCurrentStep('branch');
    } else if (validRepoId) {
      // Repo is registered (already restored above) — go straight to board
      setCurrentStep('board');
    } else {
      // Nothing the user actually created yet — restart from identity for
      // assistants so naming/emoji stays in the shared form flow.
      setCurrentStep(resumedPath === 'assistant' ? 'identity' : 'api-keys');
    }
  }, [
    open,
    user,
    assistantPending,
    path,
    repoById,
    boardById,
    branchById, // own-repo with nothing created — restart from api-keys
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

  // ─── Safety net: ensure createdRepoId is set when reaching board/branch ──
  useEffect(() => {
    if (createdRepoId || (currentStep !== 'board' && currentStep !== 'branch')) return;
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

  // No auto-advance for board or branch creation: handleCreateBoard and
  // handleCreateBranch own their success/failure transitions explicitly
  // because both are synchronous from the wizard's perspective (the daemon
  // returns the created row from the create call). Prior effects watching
  // boardById / branchById raced the handlers — see git history.

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
    (updates: {
      path?: WizardPath;
      repoId?: string;
      boardId?: string;
      branchId?: string;
      assistantDisplayName?: string;
      assistantEmoji?: string;
    }) => {
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

  const handleAssistantIdentityContinue = useCallback(() => {
    const trimmedName = assistantDisplayName.trim() || 'My Assistant';
    setAssistantDisplayName(trimmedName);
    setBranchName(`private-${slugify(trimmedName)}`);
    saveOnboardingProgress({
      assistantDisplayName: trimmedName,
      assistantEmoji: assistantEmoji || '🤖',
    });
    setError(null);
    setCurrentStep('api-keys');
  }, [assistantDisplayName, assistantEmoji, saveOnboardingProgress, setCurrentStep]);

  // Persist createdRepoId so a refresh / reset-then-resume of the wizard
  // lands back on the branch step with the repo still wired up. Without
  // this, handleCreateBranch throws "Missing repo or board" on resume
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

      // Assistant path first captures assistant identity (name + emoji) in
      // form territory. Other paths advance to api-keys after selection.
      //
      // Previously the assistant branch did `findReadyFrameworkRepo(repoById)`
      // and skipped to "board" if any framework repo was found anywhere in
      // the daemon. The framework repo is a SHARED resource (no per-user
      // attribution), so as soon as one admin or earlier user had cloned it,
      // every subsequent user picking the assistant path would silently
      // bypass the api-keys + clone steps and land on board creation. That
      // matches the reported bug: brand-new user picks "Assistant", wizard
      // skips past LLM auth and clone, lands at board / branch creation.
      //
      // The assistant clone step is now reached via the api-keys path like
      // every other tool; handleStartClone deduplicates against the shared
      // framework repo at the daemon level (so re-cloning is a no-op).
      setCurrentStep(selectedPath === 'assistant' ? 'identity' : 'api-keys');
    },
    [saveOnboardingProgress, setCurrentStep]
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
    // If we already have a board from a prior run, skip creation —
    // but only if it's actually OWNED by the current user. A leaked
    // mainBoardId pointing at someone else's board must not let us
    // short-circuit the create step.
    const existingBoardId = user?.preferences?.mainBoardId;
    if (existingBoardId && user && boardById.get(existingBoardId)?.created_by === user.user_id) {
      setCreatedBoardId(existingBoardId);
      if (path === 'assistant') {
        await ensureAssistantWelcomeNote({
          client,
          boardId: existingBoardId,
          assistantName: assistantDisplayName.trim() || 'My Assistant',
          assistantEmoji,
        });
      }
      setLoading(false);
      setCurrentStep('branch');
      return;
    }

    setError(null);
    setLoading(true);

    const userDisplayName = user?.name || user?.email?.split('@')[0] || 'My';
    const boardName =
      path === 'assistant'
        ? `${assistantDisplayName.trim() || 'My Assistant'}'s Board`
        : `${userDisplayName}'s Board`;
    const boardIcon = path === 'assistant' ? assistantEmoji || '🤖' : '\u{1F3E0}';
    try {
      if (!client) throw new Error('Not connected');
      const board = await client.service('boards').create({
        name: boardName,
        icon: boardIcon,
      });
      if (board?.board_id) {
        setCreatedBoardId(board.board_id);
        // Persist board ID immediately so restarts don't re-create it
        saveOnboardingProgress({ boardId: board.board_id });
        if (path === 'assistant') {
          await ensureAssistantWelcomeNote({
            client,
            boardId: board.board_id,
            assistantName: assistantDisplayName.trim() || 'My Assistant',
            assistantEmoji,
          });
        }
        setLoading(false);
        setCurrentStep('branch');
      }
    } catch (err) {
      setLoading(false);
      setError(`Failed to create board: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [
    client,
    user,
    boardById,
    saveOnboardingProgress,
    setCurrentStep,
    path,
    assistantDisplayName,
    assistantEmoji,
  ]);

  const launchSessionForBranch = useCallback(
    async (branchId: string, boardId: string) => {
      if (!path) {
        setError('Missing onboarding path.');
        setLoading(false);
        return;
      }

      setError(null);
      setLoading(true);

      try {
        const sessionConfig: NewSessionConfig = {
          branch_id: branchId,
          agent: selectedAgent,
          ...(path === 'assistant' && {
            initialPrompt: buildAssistantBootstrapPrompt({
              displayName: assistantDisplayName,
              emoji: assistantEmoji,
              userName: user?.name,
              userEmail: user?.email,
            }),
          }),
        };
        const sessionId =
          path === 'assistant'
            ? await startAssistantBootstrapSession({
                client,
                branchId,
                boardId,
                sessionConfig,
                onCreateSession,
              })
            : await onCreateSession(sessionConfig, boardId);

        if (sessionId) {
          setLoading(false);
          onComplete({ branchId, sessionId, boardId, path });
        } else {
          setLoading(false);
          setError('Branch created, but failed to create the first session. Please try again.');
        }
      } catch (err) {
        setLoading(false);
        setError(
          `Branch created, but failed to create the first session: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [
      path,
      selectedAgent,
      assistantDisplayName,
      assistantEmoji,
      user?.name,
      user?.email,
      onCreateSession,
      onComplete,
      client,
    ]
  );

  const handleCreateBranch = useCallback(async () => {
    if (!createdRepoId || !createdBoardId) {
      setError('Missing repo or board. Please go back and try again.');
      return;
    }

    setError(null);
    setLoading(true);

    // Branch name and ref are unified into a single input — they're almost
    // always the same for first-time users, and the underlying form elsewhere
    // exposes the same shortcut.
    const sanitized = sanitizeBranchName(branchName);
    // Fork from the repo's actual default branch (e.g. 'master' on older
    // repos), falling back to 'main' for legacy rows missing the field.
    const sourceBranch = repoById.get(createdRepoId)?.default_branch || 'main';

    try {
      const assistantConfig: AssistantConfig | null =
        path === 'assistant'
          ? {
              kind: 'assistant',
              displayName: assistantDisplayName.trim() || 'My Assistant',
              emoji: assistantEmoji || undefined,
              frameworkRepo: FRAMEWORK_REPO_SLUG,
              createdViaOnboarding: true,
            }
          : null;

      const branch = await onCreateBranch(createdRepoId, {
        name: sanitized,
        ref: sanitized,
        createBranch: true,
        sourceBranch,
        pullLatest: true,
        boardId: createdBoardId,
        ...(assistantConfig ? { custom_context: { assistant: assistantConfig } } : {}),
      });

      if (branch) {
        setCreatedBranchId(branch.branch_id);
        // Persist branch ID so restarts don't re-create it
        saveOnboardingProgress({ branchId: branch.branch_id });

        if (path === 'assistant') {
          await client
            ?.service('boards')
            .setPrimaryAssistant({ boardId: createdBoardId, branchId: branch.branch_id });
        }

        await launchSessionForBranch(branch.branch_id, createdBoardId);
      } else {
        setLoading(false);
        setError('Failed to create branch. Please try again.');
      }
    } catch (err) {
      setLoading(false);
      setError(`Failed to create branch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [
    createdRepoId,
    createdBoardId,
    path,
    branchName,
    assistantDisplayName,
    assistantEmoji,
    repoById,
    onCreateBranch,
    client,
    saveOnboardingProgress,
    launchSessionForBranch,
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
      const keyName = apiKeyNameForAgent(selectedAgent, authMethod);
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
  }, [user, apiKey, authMethod, selectedAgent, path, onUpdateUser, setCurrentStep]);

  const handleAdvanceFromApiKeys = useCallback(() => {
    setCurrentStep(path === 'own-repo' ? 'add-repo' : 'clone');
  }, [path, setCurrentStep]);

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
  }, [onCheckAuth, selectedAgent, apiKey, authMethod]);

  const handleSkip = useCallback(() => {
    if (!user) return;
    // onComplete sets onboarding_completed; updating it here too would double-PATCH.
    onComplete({
      branchId: '',
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

  // ─── Render Helpers ───────────────────────────────

  const renderWelcome = () => (
    <div style={{ padding: '8px 0' }}>
      <Title level={3} style={{ marginBottom: 8 }}>
        Welcome to Agor ✨
      </Title>
      <Paragraph style={{ marginBottom: 14, fontSize: 15 }}>
        Start by creating your{' '}
        <Typography.Link
          strong
          href="https://agor.live/guide/assistants"
          target="_blank"
          rel="noopener noreferrer"
        >
          Agor assistant
        </Typography.Link>
        : a persistent agent that can help you set up the workspace and keep things moving.
      </Paragraph>

      <div
        style={{
          background: token.colorPrimaryBg,
          border: `1px solid ${token.colorPrimaryBorder}`,
          borderRadius: 8,
          padding: '14px 16px',
          marginBottom: 16,
        }}
      >
        <Text strong>Your assistant can help:</Text>
        <ul style={{ margin: '10px 0 0', paddingLeft: 20, color: token.colorTextSecondary }}>
          <li>🧰 Connect tools and credentials</li>
          <li>🗺️ Set up your board and workflow</li>
          <li>🤝 Coordinate other agents and sessions</li>
          <li>💬 Show you around and answer questions</li>
        </ul>
      </div>

      <Paragraph type="secondary" style={{ marginBottom: 24, fontSize: 14 }}>
        Want the bigger picture first? Read the{' '}
        <Typography.Link
          href="https://agor.live/guide/getting-started"
          target="_blank"
          rel="noopener noreferrer"
        >
          getting started guide
        </Typography.Link>
        .
      </Paragraph>

      <Button
        type="primary"
        size="large"
        icon={<RobotOutlined />}
        onClick={() => handleSelectPath('assistant')}
      >
        Create your assistant
      </Button>
    </div>
  );

  const renderAssistantIdentity = () => (
    <div style={{ padding: '16px 0' }}>
      <Title level={4}>Name Your Assistant</Title>
      <Paragraph type="secondary">
        Pick the name and emoji this assistant will use in its first bootstrap session.
      </Paragraph>

      <Form layout="vertical">
        <Form.Item label="Name" required>
          <Space.Compact style={{ display: 'flex' }}>
            <EmojiPickerInput
              value={assistantEmoji}
              onChange={setAssistantEmoji}
              defaultEmoji="🤖"
            />
            <Input
              placeholder="e.g. PR Reviewer, Command Center"
              value={assistantDisplayName}
              onChange={(e) => setAssistantDisplayName(e.target.value)}
              autoFocus
              style={{ flex: 1 }}
            />
          </Space.Compact>
        </Form.Item>
      </Form>

      <Button
        type="primary"
        onClick={handleAssistantIdentityContinue}
        disabled={!assistantDisplayName.trim()}
      >
        Continue
      </Button>
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
            message="Clone failed"
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
      {error ? (
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
      ) : (
        <>
          <Spin size="large" />
          <Title level={4} style={{ marginTop: 16 }}>
            {path === 'assistant' ? "Setting up your assistant's board" : 'Creating your board'}
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {path === 'assistant'
              ? 'Agor is creating a board where your assistant can organize its work.'
              : 'Agor is creating a personal board for your work.'}
          </Paragraph>
        </>
      )}
    </div>
  );

  const renderBranch = () => {
    const sourceBranch =
      (createdRepoId ? repoById.get(createdRepoId)?.default_branch : null) || 'main';

    if (createdBranchId && createdBoardId) {
      return (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Result
            icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
            title={path === 'assistant' ? 'Assistant Branch Ready' : 'Branch Created'}
            subTitle={
              path === 'assistant'
                ? 'Start your assistant to finish onboarding.'
                : 'The branch is ready. Create the first session to finish onboarding.'
            }
          />
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
            onClick={() => launchSessionForBranch(createdBranchId, createdBoardId)}
            loading={loading}
          >
            {path === 'assistant' ? 'Start Assistant' : 'Create First Session'}
          </Button>
        </div>
      );
    }

    return (
      <div style={{ padding: '16px 0' }}>
        <Title level={4}>
          {path === 'assistant' ? 'Name Your Assistant Branch' : 'Create Your Branch'}
        </Title>
        <Paragraph type="secondary">
          {path === 'assistant'
            ? 'Your assistant works from its own branch: a safe place to use tools and keep setup context.'
            : 'A branch is an isolated workspace backed by its own git branch. Name it whatever you like. We’ll create the first session after the branch is ready.'}
        </Paragraph>

        <Form layout="vertical">
          <Form.Item
            label="Branch name"
            extra={
              path === 'assistant' ? undefined : (
                <>
                  Used as both the directory name and the new branch name. Forked from{' '}
                  <Text code>{sourceBranch}</Text>.
                </>
              )
            }
          >
            <Input
              placeholder={`private-${usernameSlug}`}
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
            />
          </Form.Item>
        </Form>

        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

        <Button
          type="primary"
          onClick={handleCreateBranch}
          loading={loading}
          disabled={!branchName.trim()}
        >
          {path === 'assistant'
            ? 'Create Branch & Start Assistant'
            : 'Create Branch & First Session'}
        </Button>
      </div>
    );
  };

  const renderApiKeys = () => {
    const hasKey = hasKeyForAgent(selectedAgent);
    // "Already auth'd" covers both stored credentials (agentic_tools / env vars
    // / system credentials) AND ambient CLI auth detected by onCheckAuth —
    // e.g. the user already configured Claude/Codex CLI auth outside the wizard.
    // Auto-flip to "{tool} is configured → Continue" ONLY when the current
    // user has THEIR OWN stored per-user credential. We intentionally do not
    // gate on `detectedAuth?.authenticated` here: the ambient probe reads
    // host-level state (daemon env vars, daemon's ~/.claude or ~/.codex), and
    // letting it auto-skip the LLM-auth step caused brand-new users to never
    // see the API-key input — they silently inherited the admin's setup. The
    // "Test Connection" button writes to manualTestResult (inline ✓/✗) and
    // is also intentionally absent here so a typed-key test never replaces
    // the Save step.
    const isAuthenticated = hasKey;

    const authMethodOptions = authMethodOptionsForAgent(selectedAgent);
    const usesCodexCliAuth = selectedAgent === 'codex' && authMethod === 'codex-cli-auth';
    const currentKeyName = apiKeyNameForAgent(selectedAgent, authMethod);

    const renderAuthHint = () => {
      if (selectedAgent === 'claude-code') {
        if (authMethod === 'claude-subscription-token') {
          return (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16, textAlign: 'left' }}
              description={
                <span>
                  Run <Text code>claude setup-token</Text> on the machine Agor runs sessions on,
                  then paste the printed token below.
                </span>
              }
            />
          );
        }

        return (
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            Paste an <Text code>ANTHROPIC_API_KEY</Text> from{' '}
            <Typography.Link href="https://platform.claude.com/settings/keys" target="_blank">
              Claude Console
            </Typography.Link>{' '}
            for pay-as-you-go API billing.
          </Paragraph>
        );
      }

      if (selectedAgent === 'codex') {
        if (usesCodexCliAuth) {
          return (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16, textAlign: 'left' }}
              description={
                <span>
                  Run <Text code>codex login --device-auth</Text> on the machine Agor runs sessions
                  on; Agor uses that local auth when no <Text code>OPENAI_API_KEY</Text> is set.
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
            </Typography.Link>{' '}
            for API billing, automation, or team-managed keys.
          </Paragraph>
        );
      }

      if (AGENT_KEY_CONSOLES[selectedAgent]) {
        return (
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            Paste your {currentKeyName} below. Get one at{' '}
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
        <Title level={4}>Choose an LLM Provider</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Pick what powers your assistant. You can change this later.
        </Paragraph>

        <Space direction="vertical" size="middle" style={{ width: '100%', marginBottom: 16 }}>
          <div
            role="radiogroup"
            aria-label="Recommended LLM providers"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
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
                  <label
                    style={{
                      display: 'block',
                      width: '100%',
                      cursor: 'pointer',
                      padding: 14,
                    }}
                  >
                    <Space align="center" size={10} style={{ width: '100%' }}>
                      <ToolIcon tool={option.value} size={32} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div>
                          <Text strong>{option.title}</Text>
                        </div>
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

        {isAuthenticated && !overrideDetectedAuth ? (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <Result
              style={{ padding: '16px 0' }}
              icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
              title={`${AGENT_LABELS[selectedAgent]} is configured`}
              subTitle={`You're all set to use ${AGENT_LABELS[selectedAgent]}.`}
            />
            <Space direction="vertical" size="small">
              <Button type="primary" onClick={handleAdvanceFromApiKeys}>
                Continue
              </Button>
              {/* Escape hatch: stored key may be stale, wrong-account, or
                  just not what the user wants (e.g. work account on file but
                  they want to use a personal key for this onboarding). */}
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
                  {authMethodOptions.map((option) => {
                    const selected = authMethod === option.value;
                    return (
                      <Radio
                        key={option.value}
                        value={option.value}
                        style={{
                          alignItems: 'center',
                          border: selected
                            ? '1px solid var(--ant-color-primary)'
                            : '1px solid var(--ant-color-border)',
                          borderRadius: 8,
                          display: 'flex',
                          marginInlineEnd: 0,
                          padding: '8px 12px',
                        }}
                      >
                        <Text strong={selected}>{option.label}</Text>
                      </Radio>
                    );
                  })}
                </div>
              </Radio.Group>
            )}

            {renderAuthHint()}

            {selectedAgent === 'opencode' && (
              <Paragraph type="secondary" style={{ marginBottom: 16 }}>
                OpenCode supports 75+ LLM providers. Configure the appropriate API key for your
                chosen provider below.
              </Paragraph>
            )}

            {!usesCodexCliAuth && (
              <Form layout="vertical">
                <Form.Item label={currentKeyName}>
                  <Input.Password
                    placeholder={apiKeyPlaceholder(selectedAgent, authMethod)}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      // Editing the key invalidates any prior test result.
                      setManualTestResult(null);
                    }}
                  />
                </Form.Item>
              </Form>
            )}

            {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

            {manualTestResult &&
              (manualTestResult.authenticated ? (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginBottom: 16, textAlign: 'left' }}
                  message="Connection works"
                  description={
                    manualTestResult.hint ||
                    (usesCodexCliAuth
                      ? 'Click Continue with Codex CLI auth to use this machine login.'
                      : 'Click Save & Continue to store this key.')
                  }
                />
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16, textAlign: 'left' }}
                  message="Not authenticated"
                  description={manualTestResult.hint}
                />
              ))}

            <Space wrap>
              {usesCodexCliAuth ? (
                <Button type="primary" onClick={handleAdvanceFromApiKeys} disabled={loading}>
                  Continue with Codex CLI auth
                </Button>
              ) : (
                <Button
                  type="primary"
                  onClick={handleSaveApiKey}
                  loading={loading}
                  disabled={!apiKey.trim()}
                  icon={<KeyOutlined />}
                >
                  Save & Continue
                </Button>
              )}
              {onCheckAuth && (
                <Button onClick={handleTestAuth} loading={testAuthLoading} disabled={loading}>
                  Test Connection
                </Button>
              )}
              {!usesCodexCliAuth && (
                <Button onClick={handleAdvanceFromApiKeys} disabled={loading}>
                  Continue without key
                </Button>
              )}
            </Space>
          </>
        )}
      </div>
    );
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 'welcome':
        return renderWelcome();
      case 'identity':
        return renderAssistantIdentity();
      case 'add-repo':
        return renderAddRepo();
      case 'clone':
        return renderClone();
      case 'board':
        return renderBoard();
      case 'branch':
        return renderBranch();
      case 'api-keys':
        return renderApiKeys();
      default:
        return null;
    }
  };

  // ─── Progress display config ─────────────────────

  const progressItems = useMemo(() => {
    if (path === 'assistant') {
      return [
        { key: 'identity' as const, title: 'Assistant', icon: <RobotOutlined /> },
        { key: 'api-keys' as const, title: 'LLM Provider', icon: <ApiOutlined /> },
        { key: 'branch' as const, title: 'Workspace', icon: <BranchesOutlined /> },
      ];
    }

    if (path === 'own-repo') {
      return [
        { key: 'api-keys' as const, title: 'LLM Provider', icon: <ApiOutlined /> },
        { key: 'add-repo' as const, title: 'Repo', icon: <FolderOpenOutlined /> },
        { key: 'branch' as const, title: 'Workspace', icon: <BranchesOutlined /> },
      ];
    }

    return [];
  }, [path]);

  const currentProgressIndex = useMemo(() => {
    if (!path || currentStep === 'welcome') return -1;
    if (path === 'assistant') {
      if (currentStep === 'identity') return 0;
      if (currentStep === 'api-keys') return 1;
      return 2;
    }
    if (currentStep === 'api-keys') return 0;
    if (currentStep === 'add-repo' || currentStep === 'clone') return 1;
    return 2;
  }, [path, currentStep]);

  const renderProgressIndicator = () => {
    if (!path || currentStep === 'welcome' || progressItems.length === 0) return null;

    return (
      <ol
        aria-label="Onboarding progress"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          marginBottom: 24,
          padding: 0,
          listStyle: 'none',
        }}
      >
        {progressItems.map((item, index) => {
          const isActive = index === currentProgressIndex;
          const color = isActive ? token.colorPrimary : token.colorTextDisabled;
          return (
            <li
              key={item.key}
              aria-current={isActive ? 'step' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color,
              }}
            >
              <Space direction="vertical" size={4} align="center">
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 999,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color,
                    background: isActive ? token.colorPrimaryBg : token.colorFillTertiary,
                    border: `1px solid ${isActive ? token.colorPrimary : token.colorBorder}`,
                    opacity: isActive ? 1 : 0.55,
                  }}
                >
                  {item.icon}
                </div>
                <Text
                  style={{
                    color,
                    fontSize: 12,
                    fontWeight: isActive ? 600 : undefined,
                    opacity: isActive ? 1 : 0.65,
                  }}
                >
                  {item.title}
                </Text>
              </Space>
              {index < progressItems.length - 1 && (
                <ArrowRightOutlined
                  style={{ color: token.colorTextDisabled, opacity: 0.55, fontSize: 12 }}
                />
              )}
            </li>
          );
        })}
      </ol>
    );
  };

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

      {/* Right: Skip */}
      <Space size="small">
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
      {/* Progress indicator (only when path is chosen) */}
      {renderProgressIndicator()}

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
