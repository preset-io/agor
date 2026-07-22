// biome-ignore-all lint/plugin/noHardcodedColorLiteral: intentional dark-glass first-run surface — bespoke gradient/particle/glass values with no semantic-token equivalent; semantic text/primary/border already use theme tokens
/**
 * OnboardingWizard — redesigned 5-step first-run flow.
 *
 * Steps: persona → workspace → llm → integrations → done
 */

import type {
  AgenticToolName,
  AgorClient,
  AuthCheckResult,
  UpdateUserInput,
  User,
  UserPreferences,
} from '@agor-live/client';
import { TOOL_API_KEY_NAMES } from '@agor-live/client';
import {
  CheckCircleOutlined,
  CheckOutlined,
  CloseOutlined,
  LeftOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { Alert, Button, Input, Modal, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { ONBOARDING_PERSONAS } from '../../utils/onboardingPersonas';
import { type CodexAuthFallback, CodexDeviceSignIn, CodexImportAuthJson } from '../CodexAuth';
import { EmojiPickerInput } from '../EmojiPickerInput/EmojiPickerInput';

const { Text, Title, Paragraph } = Typography;
const { useToken } = theme;

// ─── Types ──────────────────────────────────────────────────────────────────

export type WizardStep = 'persona' | 'llm' | 'workspace' | 'integrations' | 'done';
type AuthMethod =
  | 'api-key'
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
    { label: 'Subscription token', value: 'claude-subscription-token' },
  ],
  codex: [
    { label: 'API key', value: 'api-key' },
    { label: 'Sign in with ChatGPT', value: 'codex-device-auth' },
    { label: 'Import auth.json', value: 'codex-auth-json' },
  ],
};

// ─── Constants ───────────────────────────────────────────────────────────────

const STEPS: WizardStep[] = ['persona', 'llm', 'workspace', 'integrations', 'done'];

const STEP_META: Record<WizardStep, { number: number; label: string; skippable: boolean }> = {
  persona: { number: 1, label: 'You', skippable: true },
  llm: { number: 2, label: 'AI', skippable: true },
  workspace: { number: 3, label: 'Workspace', skippable: true },
  integrations: { number: 4, label: 'Tools', skippable: true },
  done: { number: 5, label: "You're ready", skippable: false },
};

const PERSONAS = ONBOARDING_PERSONAS;

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

interface McpRecommendation {
  id: string;
  name: string;
  emoji: string;
  description: string;
  docsUrl: string;
  featured?: boolean;
}

const MCP_DOCS_URL = 'https://agor.live/docs/mcp';

const PERSONA_MCP_RECS: Record<string, McpRecommendation[]> = {
  developer: [
    {
      id: 'slack',
      name: 'Slack',
      emoji: '💬',
      description:
        'Get notified when sessions finish, send prompts from Slack, and schedule agents that post daily build reports.',
      docsUrl: 'https://agor.live/docs/mcp/slack',
      featured: true,
    },
    {
      id: 'github',
      name: 'GitHub',
      emoji: '🐙',
      description: 'Your AI opens PRs, reviews code, and syncs issues automatically.',
      docsUrl: 'https://agor.live/docs/mcp/github',
    },
    {
      id: 'sentry',
      name: 'Sentry',
      emoji: '🚨',
      description: 'Let your AI read error traces and fix bugs straight from the issue.',
      docsUrl: 'https://agor.live/docs/mcp/sentry',
    },
    {
      id: 'datadog',
      name: 'Datadog',
      emoji: '🐕',
      description: 'Query metrics, read alerts, and have your AI investigate anomalies for you.',
      docsUrl: 'https://agor.live/docs/mcp/datadog',
    },
  ],
  pm: [
    {
      id: 'slack',
      name: 'Slack',
      emoji: '💬',
      description:
        'Post standup summaries, unblock threads, and set up agents that DM you scheduled status reports.',
      docsUrl: 'https://agor.live/docs/mcp/slack',
      featured: true,
    },
    {
      id: 'hubspot',
      name: 'HubSpot',
      emoji: '🟠',
      description: 'Pull customer context into sessions - your AI knows who you are building for.',
      docsUrl: 'https://agor.live/docs/mcp/hubspot',
    },
    {
      id: 'amplitude',
      name: 'Amplitude',
      emoji: '📈',
      description: 'Ask your AI what the data says without writing a single query.',
      docsUrl: 'https://agor.live/docs/mcp/amplitude',
    },
    {
      id: 'figma',
      name: 'Figma',
      emoji: '🎨',
      description: 'Read design files and write feedback without switching tabs.',
      docsUrl: 'https://agor.live/docs/mcp/figma',
    },
  ],
  lead: [
    {
      id: 'slack',
      name: 'Slack',
      emoji: '💬',
      description:
        'Broadcast outcomes, surface blockers, and schedule weekly digest agents that report to your team channel.',
      docsUrl: 'https://agor.live/docs/mcp/slack',
      featured: true,
    },
    {
      id: 'hubspot',
      name: 'HubSpot',
      emoji: '🟠',
      description:
        'Keep an eye on the pipeline without leaving your session - revenue visibility in context.',
      docsUrl: 'https://agor.live/docs/mcp/hubspot',
    },
    {
      id: 'linear',
      name: 'Linear',
      emoji: '🎯',
      description:
        'See what is in progress, what is blocked, and what shipped - without chasing updates.',
      docsUrl: 'https://agor.live/docs/mcp/linear',
    },
    {
      id: 'datadog',
      name: 'Datadog',
      emoji: '🐕',
      description: 'Get a live health read on your systems without pinging the on-call engineer.',
      docsUrl: 'https://agor.live/docs/mcp/datadog',
    },
  ],
  solo: [
    {
      id: 'slack',
      name: 'Slack',
      emoji: '💬',
      description:
        'Get pinged when sessions finish and run agents that talk to you on Slack - like a personal AI assistant.',
      docsUrl: 'https://agor.live/docs/mcp/slack',
      featured: true,
    },
    {
      id: 'github',
      name: 'GitHub',
      emoji: '🐙',
      description: 'Open PRs, push commits, and manage your repos hands-free.',
      docsUrl: 'https://agor.live/docs/mcp/github',
    },
    {
      id: 'stripe',
      name: 'Stripe',
      emoji: '💳',
      description: 'Ask your AI what revenue looks like today - no dashboard needed.',
      docsUrl: 'https://agor.live/docs/mcp/stripe',
    },
    {
      id: 'hubspot',
      name: 'HubSpot',
      emoji: '🟠',
      description:
        'Let your AI handle follow-ups, log calls, and keep your pipeline moving while you build.',
      docsUrl: 'https://agor.live/docs/mcp/hubspot',
    },
  ],
  _default: [
    {
      id: 'slack',
      name: 'Slack',
      emoji: '💬',
      description:
        'Get notified when sessions finish, send prompts from Slack, and schedule agents that report back to you.',
      docsUrl: 'https://agor.live/docs/mcp/slack',
      featured: true,
    },
    {
      id: 'github',
      name: 'GitHub',
      emoji: '🐙',
      description: 'Open PRs, review code, and sync issues automatically.',
      docsUrl: 'https://agor.live/docs/mcp/github',
    },
    {
      id: 'linear',
      name: 'Linear',
      emoji: '🎯',
      description: 'Pick up issues and update status automatically.',
      docsUrl: 'https://agor.live/docs/mcp/linear',
    },
    {
      id: 'notion',
      name: 'Notion',
      emoji: '📝',
      description: 'Write and update docs as your AI works.',
      docsUrl: 'https://agor.live/docs/mcp/notion',
    },
  ],
};

function validateLlmKeyPattern(agent: AgenticToolName, key: string): string | null {
  const k = key.trim();
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
  @keyframes onb-orb1 {
    0%, 100% { transform: translate(0,0) scale(1);     opacity: 0.8; }
    50%       { transform: translate(-28px,-18px) scale(1.15); opacity: 1;   }
  }
  @keyframes onb-orb2 {
    0%, 100% { transform: translate(0,0) scale(1);    opacity: 0.5; }
    50%       { transform: translate(20px,28px) scale(1.1); opacity: 0.8; }
  }
  @keyframes onb-p0 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(0px,-72px) scale(0);opacity:0} }
  @keyframes onb-p1 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(51px,-51px) scale(0);opacity:0} }
  @keyframes onb-p2 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(72px,0px) scale(0);opacity:0} }
  @keyframes onb-p3 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(51px,51px) scale(0);opacity:0} }
  @keyframes onb-p4 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(0px,72px) scale(0);opacity:0} }
  @keyframes onb-p5 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(-51px,51px) scale(0);opacity:0} }
  @keyframes onb-p6 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(-72px,0px) scale(0);opacity:0} }
  @keyframes onb-p7 { 0%{transform:translate(0,0);opacity:1} 100%{transform:translate(-51px,-51px) scale(0);opacity:0} }

  .onb-step  { animation: onb-fade-in 0.22s cubic-bezier(0.16,1,0.3,1) both; }
  .onb-check { animation: onb-pop 0.25s cubic-bezier(0.34,1.56,0.64,1) both; }
  .onb-draw  { animation: onb-draw 0.75s cubic-bezier(0.4,0,0.2,1) 0.1s both; }
  .onb-orb1  { animation: onb-orb1 9s ease-in-out infinite; }
  .onb-orb2  { animation: onb-orb2 12s ease-in-out infinite; }

  /* Glass hover — only on unselected cards; no transform (per UX preference) */
  button.onb-card[aria-pressed='false']:hover {
    background: linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.07) 100%) !important;
    border-color: rgba(255,255,255,0.24) !important;
    box-shadow: 0 6px 28px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18) !important;
  }

  /* Skip link — plain text link; suppress antd text-button hover/active fill box */
  button.onb-skip.ant-btn:hover,
  button.onb-skip.ant-btn:active,
  button.onb-skip.ant-btn:focus-visible {
    background: transparent !important;
  }

  @media (prefers-reduced-motion: reduce) {
    .onb-step,
    .onb-check,
    .onb-draw,
    .onb-orb1,
    .onb-orb2,
    .onb-particle {
      animation: none !important;
    }
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

export interface OnboardingWizardProps {
  open: boolean;
  onComplete: (result: {
    branchId: string;
    sessionId: string;
    boardId: string;
    path: 'teammate';
    /** Name of the first AI teammate to create on completion. */
    teammateName?: string;
    /** Avatar emoji for the first AI teammate (defaults to 🤖). */
    teammateEmoji?: string;
    /** Agent selected in the LLM step, used for the teammate's bootstrap session. */
    agent?: AgenticToolName | null;
    /** Persona-tailored MCP integration names to seed into the bootstrap prompt. */
    suggestedIntegrations?: string[];
    /** Persona chosen in step 1, threaded straight through so the completion
     * handler never has to wait on the async preference save. */
    persona?: string | null;
    // May run async (teammate creation) — the wizard awaits it and shows a
    // loading state until it resolves, so the modal covers the whole operation.
  }) => void | Promise<void>;
  /** Called when the user dismisses the wizard without completing it. */
  onDismiss?: () => void;

  user?: User | null;
  client: AgorClient | null;

  onUpdateUser: (userId: string, updates: UpdateUserInput) => Promise<void>;

  onCheckAuth?: (tool: AgenticToolName, apiKey?: string) => Promise<AuthCheckResult>;

  /** Re-open wizard starting at a specific step (used by tests / future callers). */
  initialStep?: WizardStep;
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
const WIZARD_SELECTED_SHADOW =
  '0 0 0 3px rgba(46,154,146,0.38), 0 6px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18)';

// ─── Component ────────────────────────────────────────────────────────────────

export function OnboardingWizard({
  open,
  onComplete,
  onDismiss,
  user,
  client,
  onUpdateUser,
  onCheckAuth,
  initialStep,
}: OnboardingWizardProps) {
  const { token } = useToken();

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
  const [currentStep, setCurrentStep] = useState<WizardStep>(initialStep || 'persona');

  // ── Step 1: persona ─────────────────────────────────────────────────────
  const [selectedPersona, setSelectedPersona] = useState<string | null>(null);

  // ── Step 2: LLM ─────────────────────────────────────────────────────────
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('api-key');
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmAuthChecking, setLlmAuthChecking] = useState<AgenticToolName | null>(null);
  const [llmAuthVerified, setLlmAuthVerified] = useState<Partial<Record<AgenticToolName, boolean>>>(
    {}
  );

  // ── Step 3: workspace — name the user's first AI teammate ─────────────────
  // The teammate's name/emoji also names the board the wizard creates for them,
  // which the teammate is later seeded onto (see App.handleOnboardingComplete).
  const [teammateName, setTeammateName] = useState('');
  const [teammateEmoji, setTeammateEmoji] = useState('🤖');
  const [createdBoardId, setCreatedBoardId] = useState<string | null>(null);
  const [boardCreating, setBoardCreating] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  // ── Step 4: integrations ─────────────────────────────────────────────────

  // ── Step 5: completion ────────────────────────────────────────────────────
  // True while the async onComplete (teammate creation + navigation) runs, so
  // the final step shows a spinner + copy instead of vanishing the modal.
  const [completing, setCompleting] = useState(false);

  // ── Reset on open ────────────────────────────────────────────────────────
  // Reset wizard state when modal opens. Clears all local state so re-opens are
  // always fresh. Excludes `user` to avoid resetting mid-flow on live user refreshes.
  useEffect(() => {
    if (!open) return;
    setCurrentStep(initialStep || 'persona');
    setSelectedPersona(null);
    setSelectedAgent(null);
    setApiKey('');
    setAuthMethod('api-key');
    setLlmError(null);
    setLlmSaving(false);
    setLlmAuthChecking(null);
    setLlmAuthVerified({});
    setTeammateName('');
    setTeammateEmoji('🤖');
    setCreatedBoardId(null);
    setBoardError(null);
    setBoardCreating(false);
    setCompleting(false);
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
    const seedKey = user?.user_id ?? '__no_user__';
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
    // Teammate name is personal ("Rusty", "Ada"…) so we leave it empty and let
    // the placeholder guide the user. Never seed createdBoardId from preferences
    // because the preference may point to a deleted board (stale mainBoardId).
    // hasExistingBoard uses boardById to verify the board actually exists.
    setTeammateName('');
    setCreatedBoardId(null);
  }, [open, user]);

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
          // stored key to "broken" — only a definitive verdict updates the flag.
          if (result.status === 'unknown') return;
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
  }, [currentStep, onCheckAuth, agentHasKey]);

  const existingBoardId = user?.preferences?.mainBoardId || null;
  // Subscribe to only THIS board rather than the whole boardById map, so the
  // wizard re-renders on changes to the user's own board, not on every board
  // write anywhere. Self-subscribing (vs a prop) still keeps the App shell out.
  const existingBoard = useAgorStore((store) =>
    existingBoardId ? (store.boardById.get(existingBoardId) ?? null) : null
  );
  const hasExistingBoard = !!(existingBoard || createdBoardId);

  const primaryEnabled = useMemo(() => {
    switch (currentStep) {
      case 'persona':
        return !!selectedPersona;
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
        // Key stored, check still in progress — keep enabled so user isn't stuck
        if (agentHasKey(selectedAgent) && llmAuthVerified[selectedAgent] === undefined) return true;
        // Require a new key with valid format (stored key absent or broken)
        if (!apiKey.trim()) return false;
        // Subscription tokens have no fixed format — any non-empty string is
        // accepted (the daemon validates the token).
        if (authMethod === 'claude-subscription-token') return true;
        return validateLlmKeyPattern(selectedAgent, apiKey.trim()) === null;
      }
      case 'workspace':
        return hasExistingBoard || teammateName.trim().length > 0;
      case 'integrations':
        return true;
      case 'done':
        return true;
    }
  }, [
    currentStep,
    selectedPersona,
    selectedAgent,
    agentIsVerifiedConnected,
    agentHasKey,
    llmAuthVerified,
    apiKey,
    authMethod,
    hasExistingBoard,
    teammateName,
  ]);

  const disabledReason = useMemo((): string | null => {
    if (llmSaving || boardCreating) return null;
    switch (currentStep) {
      case 'persona':
        return selectedPersona ? null : 'Pick one, or skip for now';
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
        if (agentHasKey(selectedAgent) && llmAuthVerified[selectedAgent] === undefined) return null;
        if (!apiKey.trim()) {
          return 'Enter your API key to continue';
        }
        const err = validateLlmKeyPattern(selectedAgent, apiKey.trim());
        return err ?? null;
      }
      case 'workspace':
        if (hasExistingBoard) return null;
        return teammateName.trim().length === 0 ? 'Name your AI teammate to continue' : null;
      default:
        return null;
    }
  }, [
    currentStep,
    selectedPersona,
    selectedAgent,
    agentIsVerifiedConnected,
    agentHasKey,
    llmAuthVerified,
    apiKey,
    authMethod,
    hasExistingBoard,
    teammateName,
    llmSaving,
    boardCreating,
  ]);

  const primaryLabel = useMemo(() => {
    switch (currentStep) {
      case 'persona':
        return selectedPersona ? 'This is me →' : 'Continue →';
      case 'llm': {
        if (
          selectedAgent &&
          agentHasKey(selectedAgent) &&
          llmAuthVerified[selectedAgent] === undefined
        )
          return 'Checking…';
        if (selectedAgent && agentIsVerifiedConnected(selectedAgent)) return 'Continue →';
        return 'Connect →';
      }
      case 'workspace':
        return hasExistingBoard ? 'Keep going →' : 'Continue →';
      case 'integrations':
        return 'Connect when done →';
      case 'done':
        return completing ? 'Setting up your AI teammate…' : 'Open my board →';
    }
  }, [
    currentStep,
    completing,
    hasExistingBoard,
    selectedPersona,
    selectedAgent,
    agentHasKey,
    llmAuthVerified,
    agentIsVerifiedConnected,
  ]);

  const canGoBack = stepIndex > 0;
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
      onUpdateUser(user.user_id, { preferences: prefs }).catch((e) => {
        console.warn('onboarding progress save failed', e);
      });
    },
    [onUpdateUser, user]
  );

  const goToStep = useCallback((step: WizardStep) => {
    setCurrentStep(step);
  }, []);

  // Stable handlers for the memoized device sign-in pane — identity-preserving
  // so its internal timers never force wizard-wide re-renders.
  const handleCodexDeviceVerified = useCallback(() => {
    setLlmAuthVerified((prev) => (prev.codex === true ? prev : { ...prev, codex: true }));
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
    goToStep('workspace');
  }, [goToStep]);

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
        if (agentIsVerifiedConnected(selectedAgent)) {
          goToStep('workspace');
          return;
        }
        // Device sign-in and login-file import both complete inside their own
        // pane; the primary button only ever advances once the attempt
        // succeeded (button is disabled until then).
        if (
          selectedAgent === 'codex' &&
          (authMethod === 'codex-device-auth' || authMethod === 'codex-auth-json')
        ) {
          if (llmAuthVerified.codex === true) goToStep('workspace');
          return;
        }
        // Key stored, auth check still running — proceed optimistically
        if (agentHasKey(selectedAgent) && llmAuthVerified[selectedAgent] === undefined) {
          goToStep('workspace');
          return;
        }
        if (!user || !apiKey.trim()) return;
        // Subscription tokens have no fixed format (see primaryEnabled/disabledReason
        // above, which already treat them as exempt) — only pattern-validate API keys.
        if (authMethod !== 'claude-subscription-token') {
          const patternErr = validateLlmKeyPattern(selectedAgent, apiKey.trim());
          if (patternErr) {
            setLlmError(patternErr);
            return;
          }
        }
        setLlmSaving(true);
        setLlmError(null);
        if (onCheckAuth) {
          try {
            const authResult = await onCheckAuth(selectedAgent, apiKey.trim());
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
        const keyName = keyNameForAgent(selectedAgent, authMethod);
        try {
          await onUpdateUser(user.user_id, {
            agentic_tools: {
              [selectedAgent]: { [keyName]: apiKey.trim() },
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
        if (!client || !teammateName.trim()) return;
        setBoardCreating(true);
        setBoardError(null);
        try {
          const board = await client.service('boards').create({
            name: teammateName.trim(),
            icon: teammateEmoji,
          });
          const newBoardId = board?.board_id ?? null;
          if (!newBoardId) {
            setBoardError('Board was created but returned no ID - try again.');
            return;
          }
          setCreatedBoardId(newBoardId);
          if (user) saveOnboardingProgress({ boardId: newBoardId });
          goToStep('integrations');
        } catch (err) {
          setBoardError(err instanceof Error ? err.message : 'Failed to create board');
        } finally {
          setBoardCreating(false);
        }
        break;
      }
      case 'integrations': {
        goToStep('done');
        break;
      }
      case 'done': {
        // existingBoard is null if mainBoardId points to a deleted board — don't pass stale IDs
        const boardIdToUse = createdBoardId || (existingBoard ? existingBoardId : '') || '';
        // Suggested MCP integrations for the chosen persona (same set shown on
        // the integrations step) — threaded into the teammate's bootstrap prompt.
        const recs = PERSONA_MCP_RECS[selectedPersona ?? '_default'] ?? PERSONA_MCP_RECS._default;
        const suggestedIntegrations = recs.map((rec) => rec.name);
        // Keep the modal up in a loading state until creation + navigation
        // finish (onComplete may run async), then it closes from the parent.
        setCompleting(true);
        try {
          await onComplete({
            branchId: '',
            sessionId: '',
            boardId: boardIdToUse,
            path: 'teammate',
            // Naming details for the first AI teammate, seeded on completion.
            teammateName: teammateName.trim() || undefined,
            teammateEmoji,
            agent: selectedAgent,
            suggestedIntegrations,
            persona: selectedPersona,
          });
        } finally {
          setCompleting(false);
        }
        break;
      }
    }
  }, [
    currentStep,
    selectedPersona,
    selectedAgent,
    agentIsVerifiedConnected,
    agentHasKey,
    llmAuthVerified,
    user,
    apiKey,
    authMethod,
    onCheckAuth,
    onUpdateUser,
    hasExistingBoard,
    client,
    teammateName,
    teammateEmoji,
    saveOnboardingProgress,
    createdBoardId,
    existingBoardId,
    existingBoard,
    onComplete,
    goToStep,
  ]);

  // ─── Progress stepper ────────────────────────────────────────────────────

  const renderProgressDots = () => (
    <div style={{ textAlign: 'center', marginBottom: 4 }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0,
          marginBottom: 10,
        }}
      >
        {STEPS.map((step, index) => {
          const isCompleted = index < stepIndex;
          const isCurrent = index === stepIndex;
          const isLast = index === STEPS.length - 1;
          return (
            <Fragment key={step}>
              <div
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
              </div>
              {!isLast && (
                <div
                  style={{
                    height: 1,
                    width: 22,
                    flexShrink: 0,
                    background: index < stepIndex ? PRIMARY : 'rgba(255,255,255,0.08)',
                    transition: 'background 0.3s ease',
                  }}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );

  // ─── Step renderers ───────────────────────────────────────────────────────

  const renderStepBadge = (title: string) => (
    <div style={{ marginBottom: 12 }}>
      <Title level={3} style={{ color: TEXT_PRIMARY, margin: 0 }}>
        {title}
      </Title>
    </div>
  );

  const renderPersona = () => {
    const firstName = user?.name?.split(' ')[0];
    const personaTitle = firstName
      ? `${firstName}, let's make this yours.`
      : "Let's make this yours.";
    return (
      <div>
        {renderStepBadge(personaTitle)}
        <Paragraph style={{ color: TEXT_SECONDARY, marginBottom: 24 }}>
          How do you work? We'll tailor your setup to what you actually need.
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
                aria-pressed={isSelected}
                className="onb-card"
                onClick={() => setSelectedPersona(persona.id)}
                style={{
                  background: isSelected ? CARD_SELECTED_BG : GLASS_CARD_BG,
                  border: isSelected ? CARD_SELECTED_BORDER : GLASS_CARD_BORDER,
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  borderRadius: 12,
                  padding: '16px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  boxShadow: isSelected ? CARD_SELECTED_SHADOW : GLASS_CARD_SHADOW,
                  transition: 'all 0.15s ease',
                  width: '100%',
                }}
              >
                <div style={{ fontSize: 24, marginBottom: 8 }}>{persona.emoji}</div>
                <div
                  style={{ color: TEXT_PRIMARY, fontWeight: 600, fontSize: 14, marginBottom: 6 }}
                >
                  {persona.title}
                </div>
                <div style={{ color: TEXT_MUTED, fontSize: 12 }}>{persona.desc}</div>
              </button>
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
          Choose a model and connect it. This powers everything - you can change it anytime in
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
            const methodOptions = AUTH_METHOD_OPTIONS[option.agent];
            return (
              <div
                key={option.id}
                style={{
                  background: isSelected ? CARD_SELECTED_BG : GLASS_CARD_BG,
                  border: isSelected ? CARD_SELECTED_BORDER : GLASS_CARD_BORDER,
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
                  <span
                    style={{
                      fontSize: 20,
                      flexShrink: 0,
                      color: TEXT_SECONDARY,
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
                        message={
                          subscriptionBroken
                            ? 'Codex login no longer found on this server — sign in with ChatGPT or import it again.'
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

                    {authMethod !== 'codex-device-auth' && authMethod !== 'codex-auth-json' && (
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

                    {authMethod === 'codex-device-auth' ? (
                      <CodexDeviceSignIn
                        client={client}
                        onVerified={handleCodexDeviceVerified}
                        onUseFallback={handleCodexAuthMethodFallback}
                      />
                    ) : authMethod === 'codex-auth-json' ? (
                      <CodexImportAuthJson client={client} onImported={handleCodexImported} />
                    ) : authMethod === 'claude-subscription-token' ? (
                      <>
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginBottom: 10, fontSize: 12 }}
                          message={
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
                        message={llmError}
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

  const renderWorkspace = () => (
    <div>
      {renderStepBadge('Name your AI teammate')}
      <Paragraph style={{ color: TEXT_SECONDARY, marginBottom: 20 }}>
        Give your AI teammate a name and an avatar. They get their own board to work on - you can
        change everything anytime.
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
              background:
                'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
              border: '1px solid rgba(255,255,255,0.13)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              borderRadius: 20,
              padding: '4px 12px',
              fontSize: 12,
              color: TEXT_SECONDARY,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.09)',
            }}
          >
            {emoji} <span style={{ color: TEXT_PRIMARY, fontWeight: 500 }}>{term}</span> - {def}
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
              Teammate name
            </Text>
            <div style={{ display: 'flex', gap: 0 }}>
              <EmojiPickerInput
                value={teammateEmoji}
                onChange={setTeammateEmoji}
                defaultEmoji="🤖"
              />
              <Input
                aria-label="Teammate name"
                placeholder="e.g. Rusty, Ada, Scout…"
                value={teammateName}
                onChange={(e) => setTeammateName(e.target.value)}
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  borderColor: 'rgba(255,255,255,0.12)',
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  flex: 1,
                }}
              />
            </div>
          </div>
          {(() => {
            const chosenOption = LLM_OPTIONS.find((o) => o.agent === selectedAgent);
            return (
              <div
                style={{
                  background: GLASS_CARD_BG,
                  border: GLASS_CARD_BORDER,
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  boxShadow: GLASS_CARD_SHADOW,
                  borderRadius: 10,
                  padding: '12px 14px',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                }}
              >
                <span style={{ fontSize: 18, flexShrink: 0 }}>🤖</span>
                <div>
                  <Text style={{ color: TEXT_PRIMARY, fontWeight: 500, fontSize: 13 }}>
                    Board's AI tool
                  </Text>
                  <div style={{ color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 }}>
                    Each board runs on one AI tool for every session created here.
                    {chosenOption
                      ? ` Currently: ${chosenOption.title}. Change anytime in Settings.`
                      : ' Connect your AI in the previous step.'}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {boardError && <Alert type="error" message={boardError} showIcon style={{ marginTop: 16 }} />}
    </div>
  );

  const renderIntegrations = () => {
    const recs = PERSONA_MCP_RECS[selectedPersona ?? '_default'] ?? PERSONA_MCP_RECS._default;
    return (
      <div>
        {renderStepBadge('Connect your tools via MCP')}

        {/* General MCP intro */}
        <div
          style={{
            padding: '10px 14px',
            marginBottom: 16,
            background: GLASS_CARD_BG,
            border: GLASS_CARD_BORDER,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: GLASS_CARD_SHADOW,
            borderRadius: 10,
            fontSize: 12,
            color: TEXT_SECONDARY,
            lineHeight: 1.6,
          }}
        >
          Agor connects your AI to external tools using{' '}
          <Typography.Link
            href={MCP_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12 }}
          >
            MCP (Model Context Protocol)
          </Typography.Link>
          . You set each one up yourself in{' '}
          <span style={{ color: TEXT_PRIMARY, fontWeight: 500 }}>Settings - MCP</span>. Here are the
          ones that work well for you.
        </div>

        {/* Persona-curated MCP recommendations — informational, no selection */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {recs.map((rec) => (
            <div
              key={rec.id}
              style={{
                background: GLASS_CARD_BG,
                border: GLASS_CARD_BORDER,
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                borderRadius: 12,
                boxShadow: GLASS_CARD_SHADOW,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 20, flexShrink: 0 }}>{rec.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: TEXT_PRIMARY, fontWeight: 600, fontSize: 13 }}>
                      {rec.name}
                    </span>
                    {rec.featured && (
                      <Tag
                        color="processing"
                        style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px', margin: 0 }}
                      >
                        Recommended
                      </Tag>
                    )}
                  </div>
                  <div style={{ color: TEXT_SECONDARY, fontSize: 12, marginTop: 1 }}>
                    {rec.description}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderDone = () => {
    const aiConnected = hasAnyLlmKey(user) || (selectedAgent !== null && apiKey.trim().length > 0);
    const workspaceReady = hasExistingBoard;

    return (
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        {/* Animated success circle + particles */}
        <div style={{ position: 'relative', width: 90, height: 90, margin: '0 auto 20px' }}>
          <svg
            width="90"
            height="90"
            viewBox="0 0 90 90"
            role="img"
            aria-label="Success"
            style={{ position: 'absolute', inset: 0 }}
          >
            <title>Success</title>
            <circle
              cx="45"
              cy="45"
              r="38"
              fill="none"
              stroke="rgba(46,154,146,0.15)"
              strokeWidth="2"
            />
            <circle
              cx="45"
              cy="45"
              r="38"
              fill="none"
              stroke="#2e9a92"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="239"
              strokeDashoffset="239"
              className="onb-draw"
              style={{ transform: 'rotate(-90deg)', transformOrigin: '45px 45px' }}
            />
          </svg>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CheckCircleOutlined
              className="onb-check"
              style={{ color: SUCCESS_GREEN, fontSize: 36, animationDelay: '0.6s' }}
            />
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

        <Title level={2} style={{ color: TEXT_PRIMARY, marginBottom: 8, marginTop: 0 }}>
          You're ready to build.
        </Title>
        <Paragraph
          style={{ color: TEXT_SECONDARY, marginBottom: 28, maxWidth: 380, margin: '0 auto 28px' }}
        >
          Open your board to start your first AI session.
        </Paragraph>

        {/* Summary checklist */}
        <div
          style={{
            background: GLASS_CARD_BG,
            border: GLASS_CARD_BORDER,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: GLASS_CARD_SHADOW,
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
              hint: 'Add in Settings - AI & Agents',
            },
            {
              label: 'Workspace ready',
              done: workspaceReady,
              hint: 'Create a board in Settings',
            },
            {
              label: 'MCP tools',
              done: false,
              hint: 'Connect anytime via Settings - MCP',
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
              <Text
                style={{
                  color: done ? TEXT_PRIMARY : TEXT_SECONDARY,
                  flex: 1,
                  fontSize: 13,
                }}
              >
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

  const isPrimaryLoading = llmSaving || boardCreating || completing;
  const effectivePrimaryEnabled = primaryEnabled && !isPrimaryLoading;

  const footer = (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 32px',
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
            type="text"
            className="onb-skip"
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
      {/* The wizard is always mounted; only inject the ambient-orb keyframes
          while it's actually open so a closed wizard adds nothing to the DOM. */}
      {open && <style>{ONB_ANIM_CSS}</style>}
      <Modal
        open={open}
        closable={false}
        mask={true}
        keyboard={false}
        footer={null}
        width={600}
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
        {/* Wrapper enables absolute-positioned orbs behind all content */}
        <div style={{ position: 'relative' }}>
          {/* Animated ambient glow orbs */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'hidden',
              pointerEvents: 'none',
              borderRadius: 20,
            }}
          >
            <div
              className="onb-orb1"
              style={{
                position: 'absolute',
                width: 360,
                height: 360,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(46,154,146,0.3) 0%, transparent 70%)',
                bottom: -130,
                right: -90,
              }}
            />
            <div
              className="onb-orb2"
              style={{
                position: 'absolute',
                width: 220,
                height: 220,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(79,109,245,0.18) 0%, transparent 70%)',
                top: -70,
                left: -50,
              }}
            />
          </div>

          {/* Dismiss button — only shown when onDismiss is provided and not on the final step */}
          {onDismiss && currentStep !== 'done' && (
            <button
              type="button"
              aria-label="Close"
              onClick={onDismiss}
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
            >
              <CloseOutlined style={{ fontSize: 12 }} />
            </button>
          )}

          {/* Progress indicator */}
          <div style={{ padding: '24px 32px 0', position: 'relative', zIndex: 1 }}>
            {renderProgressDots()}
          </div>

          {/* Step content — keyed so it re-mounts + animates on step change */}
          <div
            key={currentStep}
            className="onb-step"
            style={{
              padding: '16px 32px 20px',
              // Fixed height keeps the modal from jumping between steps; the viewport
              // cap + scroll keeps it usable on short/mobile viewports.
              height: 460,
              maxHeight: '62vh',
              overflowY: 'auto',
              position: 'relative',
              zIndex: 1,
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
        </div>
      </Modal>
    </>
  );
}
