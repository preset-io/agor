// biome-ignore-all lint/plugin/noHardcodedColorLiteral: intentional dark-glass first-run surface — bespoke gradient/particle/glass values with no semantic-token equivalent; semantic text/primary/border already use theme tokens
/**
 * OnboardingWizard — redesigned 4-step first-run flow.
 *
 * Steps: goals → workspace (name + template gallery) → llm → done
 *
 * The in-wizard recommendations step was removed; goal-tailored tools still
 * feed the first-session prompt with their real Agor setup routes, so the
 * teammate can propose them accurately in-session.
 */

import { TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
import { getAgenticToolUIIntegration } from '@agor/agentic-tools/ui';
import { generateId } from '@agor/core/ids/browser';
import type {
  AgenticToolName,
  AgorClient,
  AuthCheckResult,
  Board,
  OnboardingState,
  UpdateUserInput,
  User,
  UserPreferences,
} from '@agor-live/client';
import {
  CheckCircleOutlined,
  CheckOutlined,
  CloseOutlined,
  LeftOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { Alert, Button, Input, Modal, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VISUALLY_HIDDEN_STYLE } from '@/utils/accessibility';
import { sanitizeSecretValue } from '@/utils/sanitizeSecret';
import { useAuthenticatedAuthorityScope } from '../../hooks/useAuthorityOperationGuard';
import { useAgorStore } from '../../store/agorStore';
import {
  MAX_ONBOARDING_GOALS,
  mergeGoalIntegrationRecs,
  ONBOARDING_GOALS,
  type OnboardingIntegrationRecommendation,
} from '../../utils/onboardingGoals';
import {
  BLANK_TEMPLATE_ID,
  getTeammateTemplate,
  resolveTemplateSourceBranch,
  resolveTemplateSourceRemoteUrl,
  type TeammateGalleryCardId,
} from '../../utils/teammateTemplates';
import { ClaudeOAuthSignIn } from '../ClaudeAuth';
import { type CodexAuthFallback, CodexDeviceSignIn, CodexImportAuthJson } from '../CodexAuth';
import { GlassPanelHighlights } from '../GlassSurface/GlassPanel';
import { ToolIcon } from '../ToolIcon';
import { OnboardingTeammateGalleryStep } from './OnboardingTeammateGalleryStep';

const { Text, Title, Paragraph } = Typography;
const { useToken } = theme;
const openCodeOnboarding = getAgenticToolUIIntegration('opencode').onboardingOption;

// ─── Types ──────────────────────────────────────────────────────────────────

export type WizardStep = 'goals' | 'workspace' | 'llm' | 'done';
type AuthMethod =
  | 'api-key'
  | 'claude-oauth'
  | 'claude-subscription-token'
  | 'codex-cli-auth'
  | 'codex-auth-json'
  | 'codex-device-auth';

/**
 * Per-agent auth-method toggle entries. Agents absent here have exactly one
 * way in (an API key / endpoint URL) and render no toggle.
 */
const AUTH_METHOD_OPTIONS: Partial<
  Record<AgenticToolName, { label: string; value: AuthMethod }[]>
> = {
  'claude-code': [
    { label: 'API key', value: 'api-key' },
    { label: 'Sign in with Claude', value: 'claude-oauth' },
    { label: 'Subscription token', value: 'claude-subscription-token' },
  ],
  codex: [
    { label: 'API key', value: 'api-key' },
    { label: 'Sign in with ChatGPT', value: 'codex-device-auth' },
    { label: 'Import auth.json', value: 'codex-auth-json' },
  ],
};

// ─── Constants ───────────────────────────────────────────────────────────────

const STEPS: WizardStep[] = ['goals', 'workspace', 'llm', 'done'];

const STEP_META: Record<WizardStep, { number: number; label: string; skippable: boolean }> = {
  goals: { number: 1, label: 'Goals', skippable: true },
  workspace: { number: 2, label: 'Teammate', skippable: true },
  llm: { number: 3, label: 'AI', skippable: true },
  done: { number: 4, label: "You're ready", skippable: false },
};

const GOALS = ONBOARDING_GOALS;

interface LlmOption {
  id: string;
  agent: AgenticToolName;
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
    provider: '',
    title: openCodeOnboarding.title,
    description: openCodeOnboarding.description,
    placeholder: 'https://…',
    keyLink: null,
    keyLinkLabel: null,
  },
];

// Why an unselected goal card is disabled once two are picked. Surfaced both as
// an AntD Tooltip (hover/focus) and as visually-hidden text inside the card, so
// the reason isn't a hover-only affordance (see frontend.md a11y guidance).
const GOAL_CAP_HINT = 'Deselect one to swap it for this.';

function validateLlmKeyPattern(agent: AgenticToolName, key: string): string | null {
  const k = sanitizeSecretValue(key);
  if (!k) return null;
  switch (agent) {
    case 'claude-code':
      if (!k.startsWith('sk-ant-')) return 'Claude keys start with sk-ant-…';
      if (k.startsWith('sk-ant-oat'))
        return 'That looks like a subscription token - use the Subscription token option above.';
      if (k.length < 50) return 'Key looks incomplete - copy the full key.';
      return null;
    case 'codex':
      if (k.startsWith('sk-ant-')) return 'That looks like a Claude key - pick Claude above.';
      if (!k.startsWith('sk-')) return 'OpenAI keys start with sk-…';
      if (k.length < 30) return 'Key looks incomplete.';
      return null;
    case 'gemini':
      if (!k.startsWith('AIzaSy')) return 'Gemini keys start with AIzaSy…';
      if (k.length < 20) return 'Key looks incomplete.';
      return null;
    case 'opencode': {
      try {
        new URL(k);
        return null;
      } catch {
        return 'Enter a valid URL starting with https://';
      }
    }
    default:
      return null;
  }
}

function hasAnyLlmKey(user: User | null | undefined): boolean {
  if (!user) return false;
  const claude = user.agentic_tools?.['claude-code'];
  const codex = user.agentic_tools?.codex;
  const gemini = user.agentic_tools?.gemini;
  return !!(
    claude?.ANTHROPIC_API_KEY ||
    claude?.CLAUDE_CODE_OAUTH_TOKEN ||
    user.agentic_credential_sources?.['claude-code'] === 'managed_file' ||
    codex?.OPENAI_API_KEY ||
    user.agentic_auth_methods?.codex === 'subscription' ||
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

function getKeyLabel(agent: AgenticToolName, authMethod: AuthMethod): string {
  if (authMethod === 'claude-subscription-token') return 'Subscription token';
  // Note: the codex-auth-json method renders its own pane (CodexImportAuthJson)
  // and never reaches this label, so no case is needed for it here.
  switch (agent) {
    case 'claude-code':
      return 'Anthropic API key';
    case 'codex':
      return 'OpenAI API key';
    case 'gemini':
      return 'Google API key';
    case 'opencode':
      return 'Endpoint URL';
    default:
      return 'API key';
  }
}

// Hoisted to module scope — no reactive deps, avoids string re-allocation on every render
const ONB_ANIM_CSS = `
  @keyframes onb-fade-in {
    from { opacity: 0; transform: scale(0.97); }
    to   { opacity: 1; transform: scale(1);    }
  }
  @keyframes onb-pop {
    0%   { transform: scale(0) rotate(-15deg); }
    60%  { transform: scale(1.25) rotate(5deg); }
    100% { transform: scale(1) rotate(0deg);    }
  }
  @keyframes onb-draw {
    from { stroke-dashoffset: 239; }
    to   { stroke-dashoffset: 0;   }
  }
  @keyframes onb-p0 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(0px,-72px) scale(0);opacity:0} }
  @keyframes onb-p1 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(51px,-51px) scale(0);opacity:0} }
  @keyframes onb-p2 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(72px,0px) scale(0);opacity:0} }
  @keyframes onb-p3 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(51px,51px) scale(0);opacity:0} }
  @keyframes onb-p4 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(0px,72px) scale(0);opacity:0} }
  @keyframes onb-p5 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(-51px,51px) scale(0);opacity:0} }
  @keyframes onb-p6 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(-72px,0px) scale(0);opacity:0} }
  @keyframes onb-p7 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(-51px,-51px) scale(0);opacity:0} }

  /* Success hero: a soft accent glow fades in behind the avatar, and a single
     accent ring expands + fades once on entry — a brief celebratory settle. */
  @keyframes onb-glow {
    from { opacity: 0; transform: scale(0.7); }
    to   { opacity: 1; transform: scale(1);   }
  }
  @keyframes onb-ring {
    0%   { opacity: 0.55; transform: scale(0.72); }
    70%  { opacity: 0;    transform: scale(1.9);  }
    100% { opacity: 0;    transform: scale(1.9);  }
  }

  .onb-step  { animation: onb-fade-in 0.22s cubic-bezier(0.16,1,0.3,1) both; }
  .onb-check { animation: onb-pop 0.25s cubic-bezier(0.34,1.56,0.64,1) both; }
  .onb-draw  { animation: onb-draw 0.75s cubic-bezier(0.4,0,0.2,1) 0.1s both; }
  .onb-glow  { animation: onb-glow 0.5s ease-out both; }
  .onb-ring  { animation: onb-ring 1.1s cubic-bezier(0.16,1,0.3,1) 0.15s both; }

  /* Glass hover — only on unselected cards; no transform (per UX preference) */
  button.onb-card[aria-pressed='false']:hover {
    background: linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.07) 100%) !important;
    border-color: rgba(255,255,255,0.24) !important;
    box-shadow: 0 6px 28px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18) !important;
  }

  /* Inline layout cannot switch the goal grid at the narrow-phone boundary or
     trim nonessential workspace help on short landscape screens. These rules
     target only wizard-owned classes; no AntD internals are overridden. */
  @media (max-width: 480px) {
    .onb-goal-grid { grid-template-columns: minmax(0, 1fr) !important; }
  }

  @media (max-height: 600px) {
    .onb-workspace-intro-copy,
    .onb-workspace-helper { display: none !important; }
  }

  @media (prefers-reduced-motion: reduce) {
    .onb-step,
    .onb-check,
    .onb-draw,
    .onb-glow,
    .onb-ring,
    .onb-particle {
      animation: none !important;
    }
    .onb-workspace-collapsible { transition: none !important; }
    /* Keep the accent glow visible (just un-animated); hide the one-shot ring
       and the particle burst, which only read as motion. */
    .onb-ring,
    .onb-particle { display: none !important; }
  }
`;

// On-brand teal palette only
const PARTICLE_COLORS = ['#2e9a92', '#60d9d4', '#a5f3ef', '#2e9a92', '#60d9d4'];
const PARTICLE_DIRS = [
  [0, -72],
  [51, -51],
  [72, 0],
  [51, 51],
  [0, 72],
  [-51, 51],
  [-72, 0],
  [-51, -51],
] as const;

// ─── Props ────────────────────────────────────────────────────────────────────

export interface OnboardingCompletionResult {
  branchId: string;
  sessionId: string;
  boardId: string;
  path: 'teammate';
  /** Name of the first AI teammate to create on completion. */
  teammateName?: string;
  /** Avatar emoji for the first AI teammate (defaults to 🤖). */
  teammateEmoji?: string;
  /** Framework source branch from the chosen template; undefined = repo default. */
  sourceBranch?: string;
  /** Remote that owns sourceBranch; the teammate's destination repo remains unchanged. */
  sourceRemoteUrl?: string;
  /** Chosen gallery template id (persona); null/undefined = blank starter. */
  templateId?: string | null;
  /** Agent selected in the LLM step, used for the teammate's bootstrap session. */
  agent?: AgenticToolName | null;
  /** Goal-tailored tools/connections with their real Agor setup surface. */
  suggestedIntegrations?: OnboardingIntegrationRecommendation[];
  /** Goal ids chosen in step 1 (order-preserving, primary first; [] if
   * skipped), threaded straight through so the completion handler never has
   * to wait on the async preference save. */
  goals?: string[];
  // May run async (teammate creation) — the wizard awaits it and shows a
  // loading state until it resolves, so the modal covers the whole operation.
}

export interface OnboardingCompletionAttempt {
  /** False after dismissal, remount, rejection retirement, or authenticated-owner replacement. */
  isCurrent: () => boolean;
}

export interface OnboardingWizardProps {
  open: boolean;
  /** Synchronous owner fence for every async continuation in this wizard instance. */
  isCurrent?: () => boolean;
  onComplete: (
    result: OnboardingCompletionResult,
    attempt: OnboardingCompletionAttempt
  ) => void | Promise<void>;
  /** Called when the user dismisses the wizard without completing it. */
  onDismiss?: (progress: Partial<OnboardingState>) => void;

  user?: User | null;
  client: AgorClient | null;

  onUpdateUser: (userId: string, updates: UpdateUserInput) => Promise<void>;

  onCheckAuth?: (tool: AgenticToolName, apiKey?: string) => Promise<AuthCheckResult>;

  /** Deployment capability for daemon-driven Claude OAuth. Fail-closed by default. */
  allowClaudeOAuthSignIn?: boolean;

  /** Re-open wizard starting at a specific step (used by tests / future callers). */
  initialStep?: WizardStep;
  /** Override only for deterministic slow-operation tests. */
  completionSlowThresholdMs?: number;
}

const ALWAYS_CURRENT = () => true;
export const ONBOARDING_COMPLETION_SLOW_THRESHOLD_MS = 45_000;

async function observeSlowCompletion<T>(
  promise: Promise<T>,
  thresholdMs: number,
  onSlow: () => void
): Promise<T> {
  const timer = window.setTimeout(onSlow, thresholdMs);
  try {
    return await promise;
  } finally {
    window.clearTimeout(timer);
  }
}

// ─── Static glass layer (non-token values intentionally kept) ─────────────────

// Deep dark with strong teal pulse bottom-right and indigo hint top-left
const MODAL_BG = [
  'radial-gradient(ellipse at 25% 0%, #0e1a30 0%, #050810 60%)',
  'radial-gradient(circle at 90% 95%, rgba(46,154,146,0.32) 0%, transparent 50%)',
  'radial-gradient(circle at 0% 60%, rgba(79,109,245,0.16) 0%, transparent 45%)',
].join(', ');
// Diagonal glass gradient — light-from-top-left gives the refraction feel
const GLASS_CARD_BG =
  'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.04) 100%)';
const GLASS_CARD_BORDER = '1px solid rgba(255,255,255,0.16)';
const GLASS_CARD_SHADOW = '0 4px 20px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.13)';
// Selection — brighter glass lift, minimal teal accent
const WIZARD_SELECTED_BG =
  'linear-gradient(135deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.06) 100%)';
const WIZARD_SELECTED_BORDER = '1.5px solid rgba(46,154,146,0.95)';
// Unselected border for *selectable* cards (goals, LLM providers). Same 1.5px
// width as WIZARD_SELECTED_BORDER so selecting only changes the border COLOR,
// never the width — no box-model change, no layout shift on select/deselect.
const SELECTABLE_CARD_BORDER = '1.5px solid rgba(255,255,255,0.16)';
const WIZARD_SELECTED_SHADOW =
  '0 0 0 3px rgba(46,154,146,0.38), 0 6px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18)';

// ─── Component ────────────────────────────────────────────────────────────────

export function OnboardingWizard({
  open,
  isCurrent = ALWAYS_CURRENT,
  onComplete,
  onDismiss,
  user,
  client,
  onUpdateUser,
  onCheckAuth,
  allowClaudeOAuthSignIn = false,
  initialStep,
  completionSlowThresholdMs = ONBOARDING_COMPLETION_SLOW_THRESHOLD_MS,
}: OnboardingWizardProps) {
  const { token } = useToken();
  const savedOnboarding = user?.preferences?.onboarding;
  const savedBoardId = savedOnboarding?.boardId;
  // Resume only from a board the current tenant-scoped store can actually see.
  // A stale/deleted preference must never be treated as a valid durable step.
  const savedBoard = useAgorStore((state) =>
    savedBoardId ? state.boardById.get(savedBoardId) : undefined
  );
  const onboardingAuthority = useAuthenticatedAuthorityScope(
    client,
    user ? `${user.user_id}:${user.role}` : null
  );

  // ── Token-derived styles (live, theme-aware) ────────────────────────────
  const PRIMARY = token.colorPrimary;
  const TEXT_PRIMARY = token.colorText;
  const TEXT_SECONDARY = token.colorTextSecondary;
  const TEXT_MUTED = token.colorTextTertiary;
  const SUCCESS_GREEN = token.colorSuccess;
  const CARD_SELECTED_BG = WIZARD_SELECTED_BG;
  const CARD_SELECTED_BORDER = WIZARD_SELECTED_BORDER;
  const CARD_SELECTED_SHADOW = WIZARD_SELECTED_SHADOW;

  // ── Step state ──────────────────────────────────────────────────────────
  const [currentStep, setCurrentStep] = useState<WizardStep>(initialStep || 'goals');

  // ── Step 1: goals — multi-select, order-preserving (primary first), max 2 ──
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const toggleGoal = useCallback((id: string) => {
    setSelectedGoals((prev) => {
      if (prev.includes(id)) return prev.filter((goalId) => goalId !== id);
      if (prev.length >= MAX_ONBOARDING_GOALS) return prev;
      return [...prev, id];
    });
  }, []);

  // ── Step 3: LLM ─────────────────────────────────────────────────────────
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('api-key');
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmAuthChecking, setLlmAuthChecking] = useState<AgenticToolName | null>(null);
  const [llmAuthVerified, setLlmAuthVerified] = useState<Partial<Record<AgenticToolName, boolean>>>(
    {}
  );

  // Capability loss must immediately unmount the caller-private OAuth pane and
  // return the wizard to a non-gated path. ClaudeOAuthSignIn owns clearing any
  // pasted authorization code during that unmount.
  useEffect(() => {
    if (!allowClaudeOAuthSignIn && authMethod === 'claude-oauth') {
      setAuthMethod('api-key');
      setApiKey('');
      setLlmError(null);
    }
  }, [allowClaudeOAuthSignIn, authMethod]);

  // ── Step 2: workspace — name the user's first AI teammate ─────────────────
  // The teammate's name/emoji also names the board the wizard creates for them,
  // which the teammate is later seeded onto (see App.handleOnboardingComplete).
  const [teammateName, setTeammateName] = useState('');
  const [teammateEmoji, setTeammateEmoji] = useState('🤖');
  // Chosen gallery template id (null = nothing picked yet). Sets the default
  // avatar and the teammate's framework source branch — never the name.
  const [selectedTemplateId, setSelectedTemplateId] = useState<TeammateGalleryCardId | null>(null);
  const [invalidSavedTemplateId, setInvalidSavedTemplateId] = useState<string | null>(null);
  // The teammate's board is created ONLY at completion (the `done` handler) — a
  // fresh board named after the teammate, never before, so an abandoned run
  // leaves no orphan board. Errors from that final creation surface on step 4.
  const [boardError, setBoardError] = useState<string | null>(null);
  const [createdBoardId, setCreatedBoardId] = useState<string | null>(null);
  const boardCreationConfirmedRef = useRef(false);

  // ── Step 4: completion ────────────────────────────────────────────────────
  // True while the async onComplete (teammate creation + navigation) runs, so
  // the final step shows a spinner + copy instead of vanishing the modal.
  const [completing, setCompleting] = useState(false);
  const [completionSlow, setCompletionSlow] = useState(false);
  const completionInFlightRef = useRef(false);
  const completionAttemptGenerationRef = useRef(0);

  // ── Reset on open ────────────────────────────────────────────────────────
  // Reset wizard state when modal opens. Clears all local state so re-opens are
  // always fresh. Excludes `user` to avoid resetting mid-flow on live user refreshes.
  useEffect(() => {
    if (!open) return;
    setCurrentStep(initialStep || 'goals');
    setSelectedGoals([]);
    setSelectedAgent(null);
    setApiKey('');
    setAuthMethod('api-key');
    setLlmError(null);
    setLlmSaving(false);
    setLlmAuthChecking(null);
    setLlmAuthVerified({});
    setTeammateName('');
    setTeammateEmoji('🤖');
    setSelectedTemplateId(null);
    setInvalidSavedTemplateId(null);
    setBoardError(null);
    setCreatedBoardId(null);
    boardCreationConfirmedRef.current = false;
    setCompleting(false);
    setCompletionSlow(false);
    completionInFlightRef.current = false;
    completionAttemptGenerationRef.current += 1;
    // Force seed effect to re-run on every open for the same user
    userSeedRef.current = null;
    authCheckInFlightRef.current.clear();
  }, [open, initialStep]);

  // Guards parallel auth checks — prevents same agent being checked twice concurrently.
  const authCheckInFlightRef = useRef<Set<AgenticToolName>>(new Set());

  // Seed user-derived state once on open — runs after the reset above settles.
  // Separate from the reset effect so live user updates don't re-trigger resets.
  const userSeedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      userSeedRef.current = null;
      return;
    }
    const seedKey = `${user?.user_id ?? '__no_user__'}:${savedBoardId ?? ''}`;
    if (userSeedRef.current === seedKey) return;
    userSeedRef.current = seedKey;
    // Pre-select LLM if user already has one configured
    if (hasAnyLlmKey(user)) {
      const claude = user?.agentic_tools?.['claude-code'];
      const codex = user?.agentic_tools?.codex;
      const gemini = user?.agentic_tools?.gemini;
      if (
        claude?.ANTHROPIC_API_KEY ||
        claude?.CLAUDE_CODE_OAUTH_TOKEN ||
        user?.agentic_credential_sources?.['claude-code'] === 'managed_file' ||
        user?.env_vars?.ANTHROPIC_API_KEY
      ) {
        setSelectedAgent('claude-code');
      } else if (
        codex?.OPENAI_API_KEY ||
        user?.agentic_auth_methods?.codex === 'subscription' ||
        user?.env_vars?.OPENAI_API_KEY
      ) {
        setSelectedAgent('codex');
      } else if (gemini?.GEMINI_API_KEY || user?.env_vars?.GEMINI_API_KEY) {
        setSelectedAgent('gemini');
      }
    } else {
      setSelectedAgent(null);
    }
    if (savedBoardId) {
      setSelectedGoals(savedOnboarding?.goals ?? []);
      setTeammateName(savedOnboarding?.teammateDisplayName ?? '');
      setTeammateEmoji(savedOnboarding?.teammateEmoji ?? savedBoard?.icon ?? '🤖');
      const savedTemplateId = savedOnboarding?.teammateTemplateId;
      const savedTemplate = getTeammateTemplate(savedTemplateId);
      setSelectedTemplateId(savedTemplate?.id ?? null);
      setInvalidSavedTemplateId(savedTemplateId && !savedTemplate ? savedTemplateId : null);
      setCreatedBoardId(savedBoardId);
      boardCreationConfirmedRef.current = !!savedBoard;
      if (!initialStep) setCurrentStep('done');
    } else {
      setTeammateName('');
    }
  }, [open, user, savedBoard, savedBoardId, savedOnboarding, initialStep]);

  // ─── Derived values ──────────────────────────────────────────────────────

  const stepIndex = STEPS.indexOf(currentStep);
  const meta = STEP_META[currentStep];
  const staleTemplateError = invalidSavedTemplateId
    ? `Saved teammate template "${invalidSavedTemplateId}" is no longer available. Go back and choose another template.`
    : null;
  const completionError = staleTemplateError ?? boardError;

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
          user.agentic_credential_sources?.['claude-code'] === 'managed_file' ||
          user.env_vars?.ANTHROPIC_API_KEY
        );
      }
      if (agent === 'codex') {
        return !!(
          codex?.OPENAI_API_KEY ||
          user.agentic_auth_methods?.codex === 'subscription' ||
          user.env_vars?.OPENAI_API_KEY
        );
      }
      if (agent === 'gemini') return !!(gemini?.GEMINI_API_KEY || user.env_vars?.GEMINI_API_KEY);
      if (agent === 'opencode') {
        const opencode = user.agentic_tools?.opencode;
        return !!opencode?.[TOOL_API_KEY_NAMES.opencode ?? 'ANTHROPIC_API_KEY'];
      }
      return false;
    },
    [user]
  );

  const agentIsVerifiedConnected = useCallback(
    (agent: AgenticToolName): boolean => {
      if (!agentHasKey(agent)) return false;
      // No auth checker available — trust the stored key
      if (!onCheckAuth) return true;
      const verified = llmAuthVerified[agent];
      if (verified === undefined) return false;
      return verified;
    },
    [agentHasKey, llmAuthVerified, onCheckAuth]
  );

  // Verify stored keys when entering the LLM step.
  // authCheckInFlightRef guards duplicate concurrent calls — llmAuthVerified is intentionally
  // excluded from deps because including it would re-fire on every resolution (infinite loop).
  useEffect(() => {
    if (currentStep !== 'llm' || !onCheckAuth) return;
    const agents: AgenticToolName[] = ['claude-code', 'codex', 'gemini', 'opencode'];
    for (const agent of agents) {
      if (!agentHasKey(agent) || authCheckInFlightRef.current.has(agent)) continue;
      authCheckInFlightRef.current.add(agent);
      setLlmAuthChecking(agent);
      onCheckAuth(agent)
        .then((result) => {
          // 'unknown' = couldn't verify (transient/transport). Never downgrade a
          // stored key to "broken". Persisted Codex and managed Claude
          // subscriptions are durable results of flows that already verified
          // their executor writes, so keep those successful registrations
          // usable without turning the onboarding button into "Checking…"
          // forever.
          if (result.status === 'unknown') {
            const hasVerifiedSubscription =
              (agent === 'codex' && user?.agentic_auth_methods?.codex === 'subscription') ||
              (agent === 'claude-code' &&
                user?.agentic_credential_sources?.['claude-code'] === 'managed_file');
            if (hasVerifiedSubscription) {
              setLlmAuthVerified((prev) =>
                prev[agent] === true ? prev : { ...prev, [agent]: true }
              );
            }
            return;
          }
          setLlmAuthVerified((prev) => ({ ...prev, [agent]: result.authenticated }));
        })
        .catch(() => {
          // A thrown check is itself unknown — leave prior verification state intact.
        })
        .finally(() => {
          authCheckInFlightRef.current.delete(agent);
          if (authCheckInFlightRef.current.size === 0) setLlmAuthChecking(null);
        });
    }
  }, [
    currentStep,
    onCheckAuth,
    agentHasKey,
    user?.agentic_auth_methods?.codex,
    user?.agentic_credential_sources?.['claude-code'],
  ]);

  const primaryEnabled = useMemo(() => {
    switch (currentStep) {
      case 'goals':
        return selectedGoals.length > 0;
      case 'llm': {
        if (!selectedAgent) return false;
        if (agentIsVerifiedConnected(selectedAgent)) return true;
        // Device sign-in and login-file import both complete inside their own
        // pane — no typed input to validate. They enable once the daemon
        // confirms the login (llmAuthVerified flips before the user record
        // refresh that agentIsVerifiedConnected depends on).
        if (
          selectedAgent === 'codex' &&
          (authMethod === 'codex-device-auth' || authMethod === 'codex-auth-json')
        )
          return llmAuthVerified.codex === true;
        if (selectedAgent === 'claude-code' && authMethod === 'claude-oauth') {
          return allowClaudeOAuthSignIn && llmAuthVerified['claude-code'] === true;
        }
        // Key stored, check still in progress — keep enabled so user isn't stuck
        if (agentHasKey(selectedAgent) && llmAuthVerified[selectedAgent] === undefined) return true;
        // Require a new key with valid format (stored key absent or broken)
        if (!sanitizeSecretValue(apiKey)) return false;
        // Subscription tokens have no fixed format — any non-empty string is
        // accepted (the daemon validates the token).
        if (authMethod === 'claude-subscription-token') return true;
        return validateLlmKeyPattern(selectedAgent, sanitizeSecretValue(apiKey)) === null;
      }
      case 'workspace':
        // A teammate name is required — it names the new board we always create.
        return teammateName.trim().length > 0;
      case 'done':
        return true;
    }
  }, [
    currentStep,
    selectedGoals,
    selectedAgent,
    agentIsVerifiedConnected,
    agentHasKey,
    llmAuthVerified,
    apiKey,
    authMethod,
    allowClaudeOAuthSignIn,
    teammateName,
  ]);

  const disabledReason = useMemo((): string | null => {
    if (llmSaving || completing) return null;
    switch (currentStep) {
      case 'goals':
        return selectedGoals.length > 0 ? null : 'Pick up to two, or skip for now';
      case 'llm': {
        if (!selectedAgent) return 'Choose an AI model first';
        if (agentIsVerifiedConnected(selectedAgent)) return null;
        if (selectedAgent === 'codex' && authMethod === 'codex-device-auth') {
          return llmAuthVerified.codex === true
            ? null
            : 'Approve the sign-in code in ChatGPT first';
        }
        if (selectedAgent === 'codex' && authMethod === 'codex-auth-json') {
          return llmAuthVerified.codex === true ? null : 'Import your Codex login to continue';
        }
        if (selectedAgent === 'claude-code' && authMethod === 'claude-oauth') {
          return allowClaudeOAuthSignIn && llmAuthVerified['claude-code'] === true
            ? null
            : 'Complete Claude sign-in to continue';
        }
        if (agentHasKey(selectedAgent) && llmAuthVerified[selectedAgent] === undefined) return null;
        if (!sanitizeSecretValue(apiKey)) {
          return 'Enter your API key to continue';
        }
        const err = validateLlmKeyPattern(selectedAgent, sanitizeSecretValue(apiKey));
        return err ?? null;
      }
      case 'workspace':
        return teammateName.trim().length === 0 ? 'Name your AI teammate to continue' : null;
      default:
        return null;
    }
  }, [
    currentStep,
    selectedGoals,
    selectedAgent,
    agentIsVerifiedConnected,
    agentHasKey,
    llmAuthVerified,
    apiKey,
    authMethod,
    allowClaudeOAuthSignIn,
    teammateName,
    llmSaving,
    completing,
  ]);

  const primaryLabel = useMemo(() => {
    switch (currentStep) {
      case 'goals':
        return 'Continue →';
      case 'llm': {
        if (
          selectedAgent &&
          agentHasKey(selectedAgent) &&
          llmAuthVerified[selectedAgent] === undefined
        )
          return 'Checking…';
        if (selectedAgent && agentIsVerifiedConnected(selectedAgent)) return 'Continue →';
        if (
          selectedAgent === 'claude-code' &&
          authMethod === 'claude-oauth' &&
          llmAuthVerified['claude-code'] === true
        )
          return 'Continue →';
        return 'Connect →';
      }
      case 'workspace':
        return 'Continue →';
      case 'done': {
        const name = teammateName.trim();
        if (completing) return completionSlow ? 'Still finishing…' : 'Setting up…';
        if (completionError) return 'Try again →';
        // Verb-first primary action into the activation moment — the teammate's
        // first session — named when we have a name, generic board-open otherwise.
        return name ? `Meet ${name} →` : 'Open my board →';
      }
    }
  }, [
    currentStep,
    completing,
    completionSlow,
    selectedAgent,
    agentHasKey,
    llmAuthVerified,
    agentIsVerifiedConnected,
    authMethod,
    teammateName,
    completionError,
  ]);

  const canGoBack = stepIndex > 0;
  const isSkippable = meta.skippable && currentStep !== 'done';

  // ─── Handlers ────────────────────────────────────────────────────────────

  const saveOnboardingProgress = useCallback(
    async (updates: Record<string, unknown>) => {
      if (!isCurrent()) return false;
      if (!user || !client) throw new Error('Not connected - try again when Agor reconnects.');
      // Preferences are a whole JSON object. Fetch immediately before the patch
      // so an unrelated settings write made while the wizard was open is not
      // replaced by the user snapshot captured at mount time.
      const latestUser = (await client.service('users').get(user.user_id)) as User;
      if (!isCurrent()) return false;
      const current = (latestUser.preferences?.onboarding ?? {}) as Record<string, unknown>;
      const prefs: UserPreferences = {
        ...latestUser.preferences,
        onboarding: { ...current, ...updates },
      } as UserPreferences;
      if (!isCurrent()) return false;
      await onUpdateUser(user.user_id, { preferences: prefs });
      return isCurrent();
    },
    [client, isCurrent, onUpdateUser, user]
  );

  const goToStep = useCallback((step: WizardStep) => {
    setCurrentStep(step);
  }, []);

  // Stable handlers for the memoized device sign-in pane — identity-preserving
  // so its internal timers never force wizard-wide re-renders.
  const handleCodexDeviceVerified = useCallback(() => {
    setLlmAuthVerified((prev) => (prev.codex === true ? prev : { ...prev, codex: true }));
  }, []);

  const handleClaudeOAuthVerified = useCallback(() => {
    setLlmAuthVerified((prev) =>
      prev['claude-code'] === true ? prev : { ...prev, 'claude-code': true }
    );
  }, []);

  const handleCodexAuthMethodFallback = useCallback((target: CodexAuthFallback) => {
    setAuthMethod(target === 'import' ? 'codex-auth-json' : 'api-key');
    setApiKey('');
    setLlmError(null);
  }, []);

  // Login-file import completes inside its own pane; mirror the device flow by
  // marking codex verified so the primary button advances to the next step.
  const handleCodexImported = useCallback(() => {
    setLlmAuthVerified((prev) => (prev.codex === true ? prev : { ...prev, codex: true }));
    goToStep('done');
  }, [goToStep]);

  const handleBack = useCallback(() => {
    if (stepIndex > 0) goToStep(STEPS[stepIndex - 1]);
  }, [stepIndex, goToStep]);

  const handleSkip = useCallback(() => {
    if (currentStep === 'done') return;
    // Skip means "decide later", even if the user experimented with a card
    // first. Do not silently submit a selection they explicitly skipped.
    if (currentStep === 'goals') setSelectedGoals([]);
    // The teammate step is optional. Skip is authoritative: do not carry a
    // typed name or an experimental template into completion after the user
    // explicitly chose to continue without creating a teammate.
    if (currentStep === 'workspace') {
      setTeammateName('');
      setTeammateEmoji('🤖');
      setSelectedTemplateId(null);
    }
    // Skipping the LLM step must not leave a merely *highlighted* provider
    // behind. Selecting a card sets `selectedAgent` before any key is entered,
    // and completion reads a non-null agent as "there is a model to run on" —
    // which would bootstrap the teammate's first session with no credentials.
    // Clear it unless the provider is genuinely configured.
    if (currentStep === 'llm' && selectedAgent && !agentHasKey(selectedAgent)) {
      setSelectedAgent(null);
      setApiKey('');
      setLlmError(null);
    }
    goToStep(STEPS[stepIndex + 1]);
  }, [currentStep, stepIndex, goToStep, selectedAgent, agentHasKey]);

  const handleDismiss = useCallback(() => {
    if (!onDismiss) return;
    // Invalidate a provisioning continuation synchronously before the parent
    // closes the surface. App combines this fence with its authenticated owner.
    completionAttemptGenerationRef.current += 1;
    const name = teammateName.trim();
    onDismiss({
      ...(createdBoardId ? { boardId: createdBoardId } : {}),
      goals: selectedGoals,
      teammateDisplayName: name || undefined,
      teammateEmoji: name ? teammateEmoji : undefined,
      teammateTemplateId: name ? (selectedTemplateId ?? undefined) : undefined,
    });
  }, [createdBoardId, onDismiss, selectedGoals, selectedTemplateId, teammateEmoji, teammateName]);

  const handlePrimary = useCallback(async () => {
    if (!isCurrent()) return;
    switch (currentStep) {
      case 'goals': {
        // Goals are persisted once, authoritatively and awaited, by the
        // completion handler. An intermediate whole-preferences write here can
        // race later onboarding saves and resurrect stale data.
        goToStep('workspace');
        break;
      }
      case 'llm': {
        if (!selectedAgent) return;
        if (agentIsVerifiedConnected(selectedAgent)) {
          goToStep('done');
          return;
        }
        // Device sign-in and login-file import both complete inside their own
        // pane; the primary button only ever advances once the attempt
        // succeeded (button is disabled until then).
        if (
          selectedAgent === 'codex' &&
          (authMethod === 'codex-device-auth' || authMethod === 'codex-auth-json')
        ) {
          if (llmAuthVerified.codex === true) goToStep('done');
          return;
        }
        if (selectedAgent === 'claude-code' && authMethod === 'claude-oauth') {
          if (allowClaudeOAuthSignIn && llmAuthVerified['claude-code'] === true) goToStep('done');
          return;
        }
        // Key stored, auth check still running — proceed optimistically
        if (agentHasKey(selectedAgent) && llmAuthVerified[selectedAgent] === undefined) {
          goToStep('done');
          return;
        }
        if (!user || !sanitizeSecretValue(apiKey)) return;
        // Subscription tokens have no fixed format (see primaryEnabled/disabledReason
        // above, which already treat them as exempt) — only pattern-validate API keys.
        if (authMethod !== 'claude-subscription-token') {
          const patternErr = validateLlmKeyPattern(selectedAgent, sanitizeSecretValue(apiKey));
          if (patternErr) {
            setLlmError(patternErr);
            return;
          }
        }
        setLlmSaving(true);
        setLlmError(null);
        if (onCheckAuth) {
          try {
            const authResult = await onCheckAuth(selectedAgent, sanitizeSecretValue(apiKey));
            if (!isCurrent()) return;
            // Only block on a definitive rejection; 'unknown' (transient/transport
            // failure) proceeds to save rather than rejecting a possibly-valid key.
            if (authResult.status === 'unauthenticated') {
              setLlmError(
                authResult.hint ||
                  'API key rejected - check it is correct and has the right permissions.'
              );
              setLlmSaving(false);
              return;
            }
          } catch {
            // auth check failure is non-fatal — proceed to save anyway
          }
        }
        if (!isCurrent()) return;
        const keyName = keyNameForAgent(selectedAgent, authMethod);
        try {
          await onUpdateUser(user.user_id, {
            agentic_tools: {
              [selectedAgent]: { [keyName]: sanitizeSecretValue(apiKey) },
            } as UpdateUserInput['agentic_tools'],
          });
          if (!isCurrent()) return;
          goToStep('done');
        } catch (err) {
          if (isCurrent()) {
            setLlmError(
              `Failed to save API key: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        } finally {
          if (isCurrent()) setLlmSaving(false);
        }
        break;
      }
      case 'workspace': {
        // Step 2 no longer creates the board — that happens ONLY at completion
        // (the `done` case below), so an abandoned run never leaves an orphan
        // board. Continue requires a name; Skip remains the explicit no-teammate
        // path. When present, the name is also what the board is named after.
        goToStep('llm');
        break;
      }
      case 'done': {
        if (invalidSavedTemplateId) return;
        // React state does not update quickly enough to guard two native click
        // events delivered in the same turn. The ref is the authoritative
        // single-flight gate for board creation and completion.
        if (completionInFlightRef.current) return;
        completionInFlightRef.current = true;
        completionAttemptGenerationRef.current += 1;
        const attemptGeneration = completionAttemptGenerationRef.current;
        const completionAttempt: OnboardingCompletionAttempt = {
          isCurrent: () =>
            isCurrent() && completionAttemptGenerationRef.current === attemptGeneration,
        };
        const name = teammateName.trim();
        // Merged MCP integrations for the chosen goals, threaded into the
        // teammate's bootstrap prompt. The in-wizard MCP step was removed, but
        // this still powers the teammate proposing connections in its first session.
        const suggestedIntegrations = mergeGoalIntegrationRecs(selectedGoals);
        // Keep the modal up in a loading state until creation + navigation
        // finish (onComplete may run async), then it closes from the parent.
        setCompleting(true);
        setCompletionSlow(false);
        setBoardError(null);
        try {
          if (!isCurrent()) return;
          if (!client) throw new Error('Not connected - try again when Agor reconnects.');

          // This is a small resumable saga. Persist the client-generated id
          // BEFORE issuing create: a reload after a committed response was lost
          // must discover the same board instead of allocating another id.
          let boardId = createdBoardId ?? '';
          if (!boardId) {
            boardId = generateId();
            setCreatedBoardId(boardId);
          }
          const progressSaved = await saveOnboardingProgress({
            path: 'teammate',
            boardId,
            goals: selectedGoals,
            teammateDisplayName: name || undefined,
            teammateEmoji: name ? teammateEmoji : undefined,
            teammateTemplateId: name ? (selectedTemplateId ?? undefined) : undefined,
          });
          if (!progressSaved || !completionAttempt.isCurrent()) return;
          if (!boardCreationConfirmedRef.current) {
            let board: Board | undefined;
            try {
              board = await client.service('boards').create({
                board_id: boardId,
                name: name || (user?.name ? `${user.name}'s board` : 'My board'),
                icon: teammateEmoji,
              });
            } catch (createError) {
              // The response can fail after the server committed. Resolve the
              // client-generated ID before offering retry, so an ambiguous
              // transport failure cannot create a second board.
              try {
                board = await client.service('boards').get(boardId);
              } catch {
                throw createError;
              }
            }
            if (!isCurrent()) return;
            if (board?.board_id !== boardId) {
              setBoardError('Board creation returned an unexpected ID - try again.');
              return;
            }
            boardCreationConfirmedRef.current = true;
          }
          if (!isCurrent()) return;
          await observeSlowCompletion(
            Promise.resolve(
              onComplete(
                {
                  branchId: '',
                  sessionId: '',
                  boardId,
                  path: 'teammate',
                  // Naming details for the first AI teammate, seeded on completion.
                  teammateName: name || undefined,
                  teammateEmoji,
                  // Framework source branch from the chosen gallery template; undefined
                  // (blank / no pick) falls back to the repo default branch.
                  sourceBranch: resolveTemplateSourceBranch(selectedTemplateId),
                  sourceRemoteUrl: resolveTemplateSourceRemoteUrl(selectedTemplateId),
                  templateId: selectedTemplateId,
                  agent: selectedAgent,
                  suggestedIntegrations,
                  goals: selectedGoals,
                },
                completionAttempt
              )
            ),
            completionSlowThresholdMs,
            () => {
              // A slow-operation warning cannot cancel already-issued daemon
              // writes. Keep this attempt single-flight until it really settles;
              // X and Escape remain available if the user wants to finish later.
              if (completionAttempt.isCurrent()) setCompletionSlow(true);
            }
          );
        } catch (err) {
          if (completionAttemptGenerationRef.current === attemptGeneration) {
            // A rejection retires this attempt before retry becomes available,
            // so a stale continuation cannot commit or navigate.
            completionAttemptGenerationRef.current += 1;
          }
          if (isCurrent()) {
            setCompletionSlow(false);
            setBoardError(err instanceof Error ? err.message : 'Failed to finish setup');
          }
        } finally {
          completionInFlightRef.current = false;
          if (isCurrent()) {
            setCompleting(false);
            setCompletionSlow(false);
          }
        }
        break;
      }
    }
  }, [
    currentStep,
    isCurrent,
    selectedGoals,
    selectedAgent,
    agentIsVerifiedConnected,
    agentHasKey,
    llmAuthVerified,
    user,
    apiKey,
    authMethod,
    allowClaudeOAuthSignIn,
    onCheckAuth,
    onUpdateUser,
    client,
    teammateName,
    teammateEmoji,
    selectedTemplateId,
    invalidSavedTemplateId,
    createdBoardId,
    saveOnboardingProgress,
    onComplete,
    completionSlowThresholdMs,
    goToStep,
  ]);

  // A wizard step is a navigation event. Move focus to its heading after the
  // keyed transition mounts so keyboard and screen-reader users hear the new
  // context instead of remaining on the reused footer button.
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (stepHeadingRef.current?.dataset.step === currentStep) {
        stepHeadingRef.current.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, currentStep]);

  // ─── Progress stepper ────────────────────────────────────────────────────

  const renderProgressDots = () => (
    <div style={{ textAlign: 'center', marginBottom: 4 }}>
      <ol
        aria-label="Onboarding progress"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0,
          marginBottom: 10,
          listStyle: 'none',
          padding: 0,
        }}
      >
        {STEPS.map((step, index) => {
          const isCompleted = index < stepIndex;
          const isCurrent = index === stepIndex;
          const isLast = index === STEPS.length - 1;
          return (
            <li
              key={step}
              aria-current={isCurrent ? 'step' : undefined}
              style={{ display: 'flex', alignItems: 'center' }}
            >
              <span style={VISUALLY_HIDDEN_STYLE}>
                Step {index + 1} of {STEPS.length}: {STEP_META[step].label}.{' '}
                {isCompleted ? 'Completed' : isCurrent ? 'Current step' : 'Not started'}.
              </span>
              <span
                aria-hidden="true"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: isCompleted
                    ? PRIMARY
                    : isCurrent
                      ? 'transparent'
                      : 'rgba(255,255,255,0.05)',
                  border: isCurrent
                    ? `2px solid ${PRIMARY}`
                    : isCompleted
                      ? 'none'
                      : '1px solid rgba(255,255,255,0.12)',
                  boxShadow: isCurrent
                    ? `0 0 0 3px rgba(46,154,146,0.2), 0 0 12px rgba(46,154,146,0.3)`
                    : undefined,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 700,
                  color: isCompleted
                    ? token.colorTextLightSolid
                    : isCurrent
                      ? PRIMARY
                      : 'rgba(255,255,255,0.2)',
                  transition: 'all 0.25s ease',
                  flexShrink: 0,
                }}
              >
                {isCompleted ? <CheckOutlined style={{ fontSize: 9 }} /> : STEP_META[step].number}
              </span>
              {!isLast && (
                <span
                  aria-hidden="true"
                  style={{
                    height: 1,
                    width: 22,
                    flexShrink: 0,
                    background: index < stepIndex ? PRIMARY : 'rgba(255,255,255,0.08)',
                    transition: 'background 0.3s ease',
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );

  // ─── Step renderers ───────────────────────────────────────────────────────

  const renderStepBadge = (title: string) => (
    <div style={{ marginBottom: 12 }}>
      <Title
        ref={stepHeadingRef}
        data-step={currentStep}
        level={3}
        tabIndex={-1}
        style={{ color: TEXT_PRIMARY, margin: 0, outline: 'none' }}
      >
        {title}
      </Title>
    </div>
  );

  const renderGoals = () => {
    const firstName = user?.name?.split(' ')[0];
    const goalsTitle = firstName
      ? `${firstName}, what do you want to get done?`
      : 'What do you want to get done?';
    const atCap = selectedGoals.length >= MAX_ONBOARDING_GOALS;
    return (
      <div>
        {renderStepBadge(goalsTitle)}
        <Paragraph style={{ color: TEXT_SECONDARY, marginBottom: 18 }}>
          Pick up to two, and we'll shape your first session around them. You can skip this.
        </Paragraph>

        <div
          className="onb-goal-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
          }}
        >
          {GOALS.map((goal) => {
            const isSelected = selectedGoals.includes(goal.id);
            // At the cap, unselected cards can't be added until one is dropped.
            const isDisabled = !isSelected && atCap;
            const GoalIcon = goal.icon;
            // aria-disabled (not the native `disabled` attribute) keeps the card
            // focusable and lets the Tooltip trigger on hover AND keyboard focus;
            // the click is guarded to a no-op instead.
            return (
              <Tooltip key={goal.id} title={isDisabled ? GOAL_CAP_HINT : undefined}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-disabled={isDisabled || undefined}
                  className="onb-card"
                  onClick={() => {
                    if (!isDisabled) toggleGoal(goal.id);
                  }}
                  style={{
                    position: 'relative',
                    background: isSelected ? CARD_SELECTED_BG : GLASS_CARD_BG,
                    // Constant 1.5px width in both states — only the color changes
                    // on select, so the card never resizes/shifts (no re-click bait).
                    border: isSelected ? CARD_SELECTED_BORDER : SELECTABLE_CARD_BORDER,
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    borderRadius: 12,
                    // Tightened vertical rhythm (esp. the bottom) so all six cards
                    // fit above the footer without internal scroll; sides unchanged.
                    padding: '13px 13px 11px',
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                    opacity: isDisabled ? 0.45 : 1,
                    textAlign: 'left',
                    boxShadow: isSelected ? CARD_SELECTED_SHADOW : GLASS_CARD_SHADOW,
                    transition: 'all 0.15s ease',
                    width: '100%',
                  }}
                >
                  {/* Selection is shown by the border + background highlight alone
                      (no checkmark) — the border/highlight already read clearly. */}
                  {/* A single subtle accent tile — goals have no category, so it's an
                      understated neutral glass chip (no per-goal color), rendered as a
                      <span> so the title stays the card's first <div>. */}
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      marginBottom: 8,
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    <GoalIcon style={{ fontSize: 15, color: 'rgba(255,255,255,0.72)' }} />
                  </span>
                  {/* Title flows at its natural height (one or two lines) with a
                      single consistent gap to the description below. No min-height:
                      reserving a blank second line made one-line-title cards show a
                      larger title→description gap than two-line ones. Equal card
                      height comes from the grid, not from padding the title. */}
                  <div
                    style={{
                      color: TEXT_PRIMARY,
                      fontWeight: 600,
                      fontSize: 14,
                      lineHeight: 1.3,
                      marginBottom: 5,
                    }}
                  >
                    {goal.title}
                  </div>
                  {/* One-line floor (not two): every goal description now fits on a
                      single line at the 2-col modal width, so reserving a second
                      line only added dead space below and clipped the bottom row.
                      Row-mates still equalize via the grid's default stretch. */}
                  <div
                    style={{
                      color: TEXT_MUTED,
                      fontSize: 11.5,
                      lineHeight: 1.4,
                      minHeight: '1.4em',
                    }}
                  >
                    {goal.description}
                  </div>
                  {/* Screen-reader-only cap reason — joins the disabled card's
                      accessible name so it isn't a hover-only affordance. */}
                  {isDisabled && <span style={VISUALLY_HIDDEN_STYLE}>{GOAL_CAP_HINT}</span>}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  };

  const renderLlm = () => {
    return (
      <div>
        {renderStepBadge('Connect your AI')}
        <Paragraph style={{ color: TEXT_SECONDARY, marginBottom: 24 }}>
          Choose a model and connect it. It powers your teammate, and you can change it anytime in
          Settings.
        </Paragraph>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {LLM_OPTIONS.map((option) => {
            const isSelected = selectedAgent === option.agent;
            const hasKey = agentHasKey(option.agent);
            const isChecking = llmAuthChecking === option.agent;
            const isVerified = llmAuthVerified[option.agent];
            const effectiveHasKey = hasKey && isVerified === true;
            const keyBroken = hasKey && isVerified === false;
            // Codex "connected" may mean a subscription login (auth.json on
            // the server), not a stored key — a failed probe then means the
            // login file is gone, and API-key wording would mislead.
            const subscriptionBroken =
              keyBroken &&
              option.agent === 'codex' &&
              user?.agentic_auth_methods?.codex === 'subscription';
            const methodOptions = AUTH_METHOD_OPTIONS[option.agent]?.filter(
              (method) => method.value !== 'claude-oauth' || allowClaudeOAuthSignIn
            );
            return (
              <div
                key={option.id}
                style={{
                  background: isSelected ? CARD_SELECTED_BG : GLASS_CARD_BG,
                  // Constant border width in both states — no layout shift on select.
                  border: isSelected ? CARD_SELECTED_BORDER : SELECTABLE_CARD_BORDER,
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  borderRadius: 10,
                  boxShadow: isSelected ? CARD_SELECTED_SHADOW : GLASS_CARD_SHADOW,
                  transition: 'all 0.15s ease',
                  overflow: 'hidden',
                }}
              >
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    setSelectedAgent(option.agent);
                    setApiKey('');
                    setAuthMethod('api-key');
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
                  <ToolIcon tool={option.agent} size={22} />
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
                      {isChecking && (
                        <Tag
                          color="default"
                          style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px' }}
                        >
                          <LoadingOutlined style={{ marginRight: 4 }} />
                          Checking...
                        </Tag>
                      )}
                      {!isChecking && effectiveHasKey && (
                        <Tag
                          color="success"
                          style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px' }}
                        >
                          Connected
                        </Tag>
                      )}
                      {!isChecking && keyBroken && (
                        <Tag
                          color="error"
                          style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px' }}
                        >
                          {subscriptionBroken ? 'Login not found' : 'Key not working'}
                        </Tag>
                      )}
                    </div>
                    <div style={{ color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 }}>
                      {option.description}
                    </div>
                  </div>
                  {isSelected ? (
                    <div
                      className="onb-check"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: 'rgba(255,255,255,0.15)',
                        border: '1.5px solid rgba(255,255,255,0.5)',
                        flexShrink: 0,
                        marginTop: 2,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <CheckOutlined style={{ color: token.colorTextLightSolid, fontSize: 9 }} />
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

                {isSelected && isChecking && (
                  <div
                    style={{
                      padding: '10px 16px 14px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <LoadingOutlined style={{ color: TEXT_MUTED, fontSize: 14 }} />
                    <Text style={{ color: TEXT_MUTED, fontSize: 13 }}>Checking connection...</Text>
                  </div>
                )}

                {isSelected && !isChecking && effectiveHasKey && (
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
                      {option.title} is connected - you&apos;re all set.
                    </Text>
                  </div>
                )}

                {isSelected && !isChecking && (keyBroken || !hasKey) && (
                  <div
                    style={{
                      padding: '0 16px 16px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    {keyBroken && (
                      <Alert
                        type="warning"
                        title={
                          subscriptionBroken
                            ? 'Codex login no longer found on this server. Sign in with ChatGPT or import it again.'
                            : 'Key stored but not working - enter a new one.'
                        }
                        showIcon
                        style={{ marginTop: 12, marginBottom: 8, fontSize: 12 }}
                      />
                    )}

                    {/* Auth method toggle — agents with more than one way in */}
                    {methodOptions && (
                      <div
                        style={{
                          display: 'flex',
                          marginTop: 12,
                          marginBottom: 12,
                          borderRadius: 8,
                          border: '1px solid rgba(255,255,255,0.13)',
                          overflow: 'hidden',
                          background:
                            'linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.2) 100%)',
                          backdropFilter: 'blur(12px)',
                          WebkitBackdropFilter: 'blur(12px)',
                          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
                        }}
                      >
                        {methodOptions.map((opt, idx) => {
                          const active = authMethod === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => {
                                setAuthMethod(opt.value);
                                setApiKey('');
                                setLlmError(null);
                              }}
                              style={{
                                flex: 1,
                                padding: '7px 10px',
                                fontSize: 12,
                                fontWeight: active ? 600 : 400,
                                cursor: 'pointer',
                                border: 'none',
                                borderLeft: idx > 0 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                                background: active ? 'rgba(46,154,146,0.18)' : 'transparent',
                                color: active ? PRIMARY : TEXT_MUTED,
                                transition: 'background 0.15s ease, color 0.15s ease',
                              }}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {authMethod !== 'codex-device-auth' &&
                      authMethod !== 'codex-auth-json' &&
                      authMethod !== 'claude-oauth' && (
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginTop: !methodOptions && !keyBroken ? 12 : 0,
                            marginBottom: 8,
                          }}
                        >
                          <Text style={{ color: TEXT_PRIMARY, fontSize: 13, fontWeight: 500 }}>
                            {getKeyLabel(option.agent, authMethod)}
                          </Text>
                          {option.keyLink && authMethod === 'api-key' && (
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
                      )}

                    {authMethod === 'claude-oauth' && allowClaudeOAuthSignIn ? (
                      <ClaudeOAuthSignIn
                        client={client}
                        operationScope={onboardingAuthority.operationScope}
                        connected={
                          user?.agentic_credential_sources?.['claude-code'] === 'managed_file'
                        }
                        onVerified={handleClaudeOAuthVerified}
                      />
                    ) : authMethod === 'codex-device-auth' ? (
                      <CodexDeviceSignIn
                        client={client}
                        operationScope={onboardingAuthority.operationScope}
                        onVerified={handleCodexDeviceVerified}
                        onUseFallback={handleCodexAuthMethodFallback}
                      />
                    ) : authMethod === 'codex-auth-json' ? (
                      <CodexImportAuthJson
                        client={client}
                        identityKey={onboardingAuthority.identityKey}
                        operationScope={onboardingAuthority.operationScope}
                        onImported={handleCodexImported}
                      />
                    ) : authMethod === 'claude-subscription-token' ? (
                      <>
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginBottom: 10, fontSize: 12 }}
                          title={
                            <span>
                              For claude.ai Pro or Max subscribers. In any terminal with Claude Code
                              installed, run <code>claude setup-token</code>, then paste the printed
                              token below. Need Claude Code?{' '}
                              <Typography.Link
                                href="https://docs.claude.com/en/docs/claude-code/setup"
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Install docs
                              </Typography.Link>
                              .
                            </span>
                          }
                        />
                        <Input.Password
                          aria-label="Claude subscription token"
                          placeholder="Paste token from claude setup-token…"
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
                      </>
                    ) : (
                      <Input.Password
                        aria-label={getKeyLabel(option.agent, authMethod)}
                        placeholder={option.placeholder}
                        value={apiKey}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          if (selectedAgent)
                            setLlmError(validateLlmKeyPattern(selectedAgent, e.target.value));
                        }}
                        style={{
                          background: 'rgba(0,0,0,0.3)',
                          borderColor: 'rgba(255,255,255,0.12)',
                          fontFamily: 'monospace',
                          fontSize: 13,
                        }}
                      />
                    )}

                    <Text
                      style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 8, display: 'block' }}
                    >
                      Stored securely - never shared or logged.
                    </Text>
                    {llmError && (
                      <Alert
                        type="error"
                        title={llmError}
                        showIcon
                        style={{ marginTop: 10, fontSize: 12 }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Selecting a template sets the default avatar (and later the source branch),
  // but never the name — the name stays personal and user-chosen. Passing null
  // clears the pick (deselect) and restores the default avatar.
  const applyTemplate = (templateId: TeammateGalleryCardId | null) => {
    setSelectedTemplateId(templateId);
    setInvalidSavedTemplateId(null);
    setTeammateEmoji(getTeammateTemplate(templateId)?.emoji || '🤖');
  };

  const renderWorkspace = () => (
    <OnboardingTeammateGalleryStep
      goals={selectedGoals}
      selectedTemplateId={selectedTemplateId}
      onTemplateChange={applyTemplate}
      teammateName={teammateName}
      onTeammateNameChange={setTeammateName}
      teammateEmoji={teammateEmoji}
      onTeammateEmojiChange={setTeammateEmoji}
      headingRef={stepHeadingRef}
    />
  );

  const renderDone = () => {
    const name = teammateName.trim();
    // Role = the picked template's title; the blank starter is a starting point,
    // not a role, so it never reads as a job title on the hero.
    const template =
      selectedTemplateId && selectedTemplateId !== BLANK_TEMPLATE_ID
        ? getTeammateTemplate(selectedTemplateId)
        : undefined;
    const roleTitle = template?.title;

    // Adaptive, teammate-centric copy. An unnamed teammate can't be heroed, so it
    // keeps the warm generic headline; a named one is celebrated by name (+ role).
    let headline: string;
    let subline: string;
    if (completionError) {
      headline = name ? `${name} needs one more try.` : 'Setup needs one more try.';
      subline = 'Nothing was lost. Review the error below, then try again.';
    } else if (!name) {
      headline = completing ? 'Almost ready…' : "You're ready to build.";
      subline = "Your board is ready. Open it and start whenever you're ready.";
    } else {
      // One warm line for every named variant — the headline (${name} is ready.)
      // and the role pill already carry the specifics, so the subline just lands
      // "the teammate is yours; shape it by talking to it." No goal-listing.
      headline = completing ? `${name} is almost ready.` : `${name} is ready.`;
      subline = `${name} is all yours. Start a chat and tell them what you need. You'll shape how they work as you go.`;
    }

    return (
      // Vertically centered within the step body (see the `done` branch of the
      // step container): auto margins balance the hero above the pinned footer.
      <div style={{ textAlign: 'center', padding: '6px 0', margin: 'auto 0' }}>
        {/* Teammate hero — the avatar (their own emoji) IS the celebration: a soft
            accent glow + a one-shot ring pulse + a particle burst frame it. */}
        <div style={{ position: 'relative', width: 92, height: 92, margin: '0 auto 18px' }}>
          {/* Soft radial accent glow behind the avatar. */}
          <div
            aria-hidden="true"
            className="onb-glow"
            style={{
              position: 'absolute',
              inset: -34,
              borderRadius: '50%',
              background:
                'radial-gradient(circle, rgba(46,154,146,0.45) 0%, rgba(46,154,146,0.14) 42%, transparent 70%)',
              filter: 'blur(4px)',
              pointerEvents: 'none',
            }}
          />
          {/* One-shot accent ring that expands + fades on entry. */}
          <div
            aria-hidden="true"
            className="onb-ring"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              border: '2px solid rgba(46,154,146,0.6)',
              pointerEvents: 'none',
            }}
          />
          <div
            className="onb-check"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              fontSize: 46,
              lineHeight: 1,
              background: GLASS_CARD_BG,
              border: GLASS_CARD_BORDER,
              boxShadow: GLASS_CARD_SHADOW,
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
            }}
          >
            <span aria-hidden="true">{teammateEmoji || '🤖'}</span>
          </div>
          {PARTICLE_DIRS.map(([px, py], i) => (
            <div
              key={`${px}:${py}`}
              aria-hidden="true"
              className="onb-particle"
              style={{
                position: 'absolute',
                width: 7,
                height: 7,
                borderRadius: px === 0 || py === 0 ? '50%' : 2,
                background: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
                top: '50%',
                left: '50%',
                marginTop: -3.5,
                marginLeft: -3.5,
                animation: `onb-p${i} 0.8s cubic-bezier(0.4,0,0.2,1) ${0.35 + i * 0.04}s both`,
              }}
            />
          ))}
        </div>

        {/* Role pill — reads like the job title you just hired for. */}
        {roleTitle && (
          <div
            style={{
              display: 'inline-block',
              color: PRIMARY,
              background: 'rgba(46,154,146,0.14)',
              border: '1px solid rgba(46,154,146,0.4)',
              borderRadius: 999,
              padding: '2px 12px',
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 10,
            }}
          >
            {roleTitle}
          </div>
        )}

        <Title
          ref={stepHeadingRef}
          data-step={currentStep}
          level={2}
          tabIndex={-1}
          style={{ color: TEXT_PRIMARY, margin: '0 0 8px', outline: 'none' }}
        >
          {headline}
        </Title>
        <Paragraph style={{ color: TEXT_SECONDARY, maxWidth: 400, margin: '0 auto' }}>
          {subline}
        </Paragraph>

        {completionSlow && (
          <Alert
            type="warning"
            title="Setup is taking longer than expected. It is still finishing; you can close and finish later."
            showIcon
            style={{ marginTop: 18, textAlign: 'left' }}
          />
        )}

        {completionError && !completionSlow && (
          <Alert
            type="error"
            title={completionError}
            showIcon
            style={{ marginTop: 18, textAlign: 'left' }}
          />
        )}
      </div>
    );
  };

  // ─── Footer ───────────────────────────────────────────────────────────────

  const isPrimaryLoading = llmSaving || completing;
  const effectivePrimaryEnabled = primaryEnabled && !isPrimaryLoading;

  const footer = (
    <div
      className="onb-footer"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px clamp(16px, 4.4vw, 32px)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)',
        position: 'relative',
        zIndex: 1,
      }}
    >
      <div>
        {canGoBack && (
          <Button
            type="text"
            icon={<LeftOutlined />}
            onClick={handleBack}
            disabled={completing}
            style={{ color: TEXT_SECONDARY, paddingLeft: 0 }}
          >
            Back
          </Button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {isSkippable && (
          <Button
            type="link"
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
        <Tooltip title={!effectivePrimaryEnabled ? disabledReason : undefined}>
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
        </Tooltip>
      </div>
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* The wizard is always mounted; only inject its step/celebration
          keyframes while open so a closed wizard adds nothing to the DOM. */}
      {open && <style>{ONB_ANIM_CSS}</style>}
      <Modal
        open={open}
        closable={false}
        mask={{ closable: false }}
        keyboard={Boolean(onDismiss)}
        onCancel={() => {
          handleDismiss();
        }}
        footer={null}
        // Widened from 600 → 730 so step-2's gallery fits 3 cards per row while
        // the step-1 goal cards (explicit 2-col grid) simply get more room, keeping
        // their titles on one line.
        width={730}
        // Vertically center instead of antd's default fixed top:100 so the
        // footer stays on-screen on shorter laptop viewports (the content
        // region's vh cap keeps header + grid + footer within the viewport).
        centered
        style={{
          background: MODAL_BG,
          borderRadius: 20,
          padding: 0,
          boxShadow: '0 48px 120px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,0.14)',
          overflow: 'hidden',
        }}
        styles={{
          mask: {
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            background: 'rgba(0,0,0,0.35)',
          },
          body: { padding: 0 },
        }}
      >
        {/* Wrapper enables shared ambient highlights behind all content */}
        <div style={{ position: 'relative' }}>
          <GlassPanelHighlights intensity="strong" animated={open} />

          {/* Dismiss/defer is available on every step, including completion errors. */}
          {onDismiss && (
            <Button
              type="text"
              size="small"
              aria-label="Close"
              onClick={handleDismiss}
              icon={<CloseOutlined style={{ fontSize: 12 }} />}
              style={{
                position: 'absolute',
                top: 16,
                right: 16,
                zIndex: 10,
                background:
                  'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
                border: '1px solid rgba(255,255,255,0.15)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                borderRadius: 8,
                width: 30,
                height: 30,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: TEXT_MUTED,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
                transition: 'background 0.15s ease',
              }}
            />
          )}

          {/* Progress indicator */}
          <div
            className="onb-progress"
            style={{
              padding: '18px clamp(16px, 4.4vw, 32px) 0',
              position: 'relative',
              zIndex: 1,
            }}
          >
            {renderProgressDots()}
          </div>

          {/* Step content — keyed so it re-mounts + animates on step change */}
          <div
            key={currentStep}
            className="onb-step"
            style={{
              padding: '14px clamp(16px, 4.4vw, 32px) 18px',
              // Fixed height keeps the modal from jumping between steps; the viewport
              // cap + scroll keeps it usable on short/mobile viewports. The cap is
              // high enough that the fixed height is honored on typical laptop
              // viewports so the goals grid + footer are never clipped.
              boxSizing: 'border-box',
              height: 'min(460px, calc(100dvh - 192px))',
              position: 'relative',
              zIndex: 1,
              // Step 2 owns its scrolling via an inner two-region layout (fixed
              // header + a card region that is the only scroller), so this
              // container must NOT scroll — it becomes a flex column that clips.
              // Step 4 (done) is a flex column too, so the success hero can center
              // vertically via auto margins (and still scroll if it ever overflows).
              // Every other step scrolls as one block here.
              ...(currentStep === 'workspace'
                ? { display: 'flex', flexDirection: 'column', overflow: 'hidden' }
                : currentStep === 'done'
                  ? { display: 'flex', flexDirection: 'column', overflowY: 'auto' }
                  : { overflowY: 'auto' }),
            }}
          >
            {currentStep === 'goals' && renderGoals()}
            {currentStep === 'llm' && renderLlm()}
            {currentStep === 'workspace' && renderWorkspace()}
            {currentStep === 'done' && renderDone()}
          </div>

          {/* Footer */}
          {footer}
        </div>
      </Modal>
    </>
  );
}
