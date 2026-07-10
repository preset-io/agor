import type { AgenticToolName, AuthCheckStatus, User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  BannerDecision,
  type BannerDecisionInput,
  decideBanner,
  hasAnyLlmKey,
  ProbeState,
  resolveProbeAgent,
  resolveProbeState,
} from './bannerLogic';

const baseInput: BannerDecisionInput = {
  onboardingCompleted: true,
  hasLlm: false,
  probeState: ProbeState.Unknown,
  canManageMcp: true,
  mcpServerCount: 0,
  gatewayChannelCount: 0,
  integrationsHydrated: true,
  integrationsBannerDismissed: false,
};

const asUser = (partial: Partial<User>): User => partial as User;

describe('decideBanner — fail-safe amber banners', () => {
  it('no DB key but probe authenticated → does NOT show the "No AI" banner (bug 1 fix)', () => {
    // The claude /login / executor-filesystem case: hasLlm is false but the tool is reachable.
    expect(
      decideBanner({ ...baseInput, hasLlm: false, probeState: ProbeState.Authenticated })
    ).not.toBe(BannerDecision.NoAi);
  });

  it('probe unknown (loading) → shows neither amber banner', () => {
    expect(decideBanner({ ...baseInput, hasLlm: false, probeState: ProbeState.Unknown })).toBe(
      BannerDecision.None
    );
    expect(decideBanner({ ...baseInput, hasLlm: true, probeState: ProbeState.Unknown })).not.toBe(
      BannerDecision.KeyInvalid
    );
  });

  it('probe unauthenticated + no DB key → "No AI" banner', () => {
    expect(
      decideBanner({ ...baseInput, hasLlm: false, probeState: ProbeState.Unauthenticated })
    ).toBe(BannerDecision.NoAi);
  });

  it('probe unauthenticated + DB key present → "key invalid" banner', () => {
    expect(
      decideBanner({ ...baseInput, hasLlm: true, probeState: ProbeState.Unauthenticated })
    ).toBe(BannerDecision.KeyInvalid);
  });
});

describe('decideBanner — integrations banner', () => {
  it('has a gateway channel, zero MCP servers → does NOT show integrations banner (bug 2 fix)', () => {
    expect(
      decideBanner({
        ...baseInput,
        probeState: ProbeState.Authenticated,
        mcpServerCount: 0,
        gatewayChannelCount: 1,
      })
    ).toBe(BannerDecision.None);
  });

  it('AI ok + zero MCP + zero gateway channels → shows integrations banner', () => {
    expect(
      decideBanner({
        ...baseInput,
        probeState: ProbeState.Authenticated,
        mcpServerCount: 0,
        gatewayChannelCount: 0,
      })
    ).toBe(BannerDecision.Integrations);
  });

  it('has an MCP server, zero gateway channels → does NOT show integrations banner', () => {
    expect(
      decideBanner({ ...baseInput, probeState: ProbeState.Authenticated, mcpServerCount: 1 })
    ).toBe(BannerDecision.None);
  });

  it('is suppressed while dismissed, when AI cannot be confirmed, or when MCP is unmanageable', () => {
    expect(
      decideBanner({
        ...baseInput,
        probeState: ProbeState.Authenticated,
        integrationsBannerDismissed: true,
      })
    ).toBe(BannerDecision.None);
    // Probe still loading and no DB key → AI not confirmed ok → no teal banner yet.
    expect(decideBanner({ ...baseInput, probeState: ProbeState.Unknown })).toBe(
      BannerDecision.None
    );
    expect(
      decideBanner({ ...baseInput, probeState: ProbeState.Authenticated, canManageMcp: false })
    ).toBe(BannerDecision.None);
  });

  it('shows the teal banner for a DB-key user even while the probe is still loading', () => {
    expect(decideBanner({ ...baseInput, hasLlm: true, probeState: ProbeState.Unknown })).toBe(
      BannerDecision.Integrations
    );
  });

  it('is suppressed until both integration collections have hydrated (no pre-hydration flash)', () => {
    expect(
      decideBanner({
        ...baseInput,
        probeState: ProbeState.Authenticated,
        integrationsHydrated: false,
      })
    ).toBe(BannerDecision.None);
  });
});

describe('decideBanner — onboarding gate', () => {
  it('never shows any banner before onboarding completes', () => {
    expect(
      decideBanner({
        ...baseInput,
        onboardingCompleted: false,
        probeState: ProbeState.Unauthenticated,
      })
    ).toBe(BannerDecision.None);
  });
});

describe('resolveProbeAgent', () => {
  it('prefers the tool a stored DB key points at', () => {
    expect(resolveProbeAgent(asUser({ agentic_tools: { codex: { OPENAI_API_KEY: 'sk' } } }))).toBe(
      'codex'
    );
  });

  it('resolves the tool a Cursor / Copilot stored key points at', () => {
    expect(resolveProbeAgent(asUser({ agentic_tools: { cursor: { CURSOR_API_KEY: 'k' } } }))).toBe(
      'cursor'
    );
    expect(
      resolveProbeAgent(asUser({ agentic_tools: { copilot: { COPILOT_GITHUB_TOKEN: 't' } } }))
    ).toBe('copilot');
  });

  it('falls back to the onboarding-selected agent when no DB key is present', () => {
    expect(resolveProbeAgent(asUser({ default_agentic_config: { gemini: {} } }))).toBe('gemini');
    // OpenCode is server-based (no credential field) — a user who selected it must
    // still resolve to probing opencode, not fall through to claude-code.
    expect(resolveProbeAgent(asUser({ default_agentic_config: { opencode: {} } }))).toBe(
      'opencode'
    );
  });

  it('maps a claude-code-cli stored key to the claude-code probe target', () => {
    expect(
      resolveProbeAgent(
        asUser({ agentic_tools: { 'claude-code-cli': { CLAUDE_CODE_OAUTH_TOKEN: 't' } } })
      )
    ).toBe('claude-code');
  });

  it('falls back to claude-code when nothing is known', () => {
    expect(resolveProbeAgent(null)).toBe('claude-code');
    expect(resolveProbeAgent(asUser({}))).toBe('claude-code');
  });
});

describe('resolveProbeState — multi-tool fallback', () => {
  const collect = (map: Partial<Record<AgenticToolName, AuthCheckStatus>>) => {
    const calls: AgenticToolName[] = [];
    const checkStatus = (tool: AgenticToolName): Promise<AuthCheckStatus> => {
      calls.push(tool);
      return Promise.resolve(map[tool] ?? 'unauthenticated');
    };
    return { calls, checkStatus };
  };

  it('returns Authenticated on a working primary without any fallback probes', async () => {
    const { calls, checkStatus } = collect({ codex: 'authenticated' });
    expect(await resolveProbeState(checkStatus, 'codex', false)).toBe(ProbeState.Authenticated);
    expect(calls).toEqual(['codex']);
  });

  it('returns Unknown (fail safe) when the primary probe is unknown', async () => {
    const { checkStatus } = collect({ 'claude-code': 'unknown' });
    expect(await resolveProbeState(checkStatus, 'claude-code', false)).toBe(ProbeState.Unknown);
  });

  it('does NOT fall back when a stored key is present — unauthenticated is key-invalid', async () => {
    const { calls, checkStatus } = collect({ gemini: 'unauthenticated' });
    expect(await resolveProbeState(checkStatus, 'gemini', true)).toBe(ProbeState.Unauthenticated);
    expect(calls).toEqual(['gemini']);
  });

  it('probes other native tools when primary is unauthenticated and no key; a hit clears the banner', async () => {
    // gemini (wrong resolved tool) unauthenticated, but claude /login works.
    const { calls, checkStatus } = collect({
      gemini: 'unauthenticated',
      'claude-code': 'authenticated',
    });
    expect(await resolveProbeState(checkStatus, 'gemini', false)).toBe(ProbeState.Authenticated);
    expect(calls).toContain('claude-code');
  });

  it('concludes Unauthenticated only when EVERY probe positively says so', async () => {
    const { checkStatus } = collect({}); // everything defaults to unauthenticated
    expect(await resolveProbeState(checkStatus, 'gemini', false)).toBe(ProbeState.Unauthenticated);
  });

  it('fails safe to Unknown if any fallback probe is unknown', async () => {
    const { checkStatus } = collect({ gemini: 'unauthenticated', 'claude-code': 'unknown' });
    expect(await resolveProbeState(checkStatus, 'gemini', false)).toBe(ProbeState.Unknown);
  });

  it('does not re-probe the primary tool during fallback', async () => {
    const { calls, checkStatus } = collect({
      'claude-code': 'unauthenticated',
      codex: 'unauthenticated',
    });
    await resolveProbeState(checkStatus, 'claude-code', false);
    expect(calls.filter((t) => t === 'claude-code')).toHaveLength(1);
  });
});

describe('other-tool false positives (Cursor / Copilot / OpenCode)', () => {
  it('a Cursor-connected user probes cursor and, once authenticated, sees no "No AI" banner', () => {
    const user = asUser({ agentic_tools: { cursor: { CURSOR_API_KEY: 'k' } } });
    expect(resolveProbeAgent(user)).toBe('cursor');
    // hasLlm is true (stored key) → an unauthenticated probe would word as key-invalid,
    // but an authenticated probe shows no amber banner at all.
    expect(
      decideBanner({ ...baseInput, hasLlm: true, probeState: ProbeState.Authenticated })
    ).not.toBe(BannerDecision.KeyInvalid);
  });

  it('an OpenCode user (no DB key) probes opencode; authenticated → no "No AI" banner', () => {
    const user = asUser({ default_agentic_config: { opencode: {} } });
    expect(resolveProbeAgent(user)).toBe('opencode');
    expect(hasAnyLlmKey(user)).toBe(false);
    expect(
      decideBanner({ ...baseInput, hasLlm: false, probeState: ProbeState.Authenticated })
    ).not.toBe(BannerDecision.NoAi);
  });
});

describe('hasAnyLlmKey', () => {
  it('is false for a user with no stored keys (executor-filesystem creds are invisible here)', () => {
    expect(hasAnyLlmKey(asUser({}))).toBe(false);
    expect(hasAnyLlmKey(null)).toBe(false);
  });

  it('is true for any supported tool with a stored key, including Cursor / Copilot', () => {
    expect(
      hasAnyLlmKey(asUser({ agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: 'sk' } } }))
    ).toBe(true);
    expect(hasAnyLlmKey(asUser({ agentic_tools: { cursor: { CURSOR_API_KEY: 'k' } } }))).toBe(true);
    expect(
      hasAnyLlmKey(asUser({ agentic_tools: { copilot: { COPILOT_GITHUB_TOKEN: 't' } } }))
    ).toBe(true);
  });

  it('reads keys stored as plain env vars too', () => {
    expect(hasAnyLlmKey(asUser({ env_vars: { GEMINI_API_KEY: { value: 'g' } } }))).toBe(true);
  });

  it('ignores non-credential fields — a base-URL-only user has no key', () => {
    expect(
      hasAnyLlmKey(
        asUser({ agentic_tools: { 'claude-code': { ANTHROPIC_BASE_URL: 'https://x' } } })
      )
    ).toBe(false);
  });
});
