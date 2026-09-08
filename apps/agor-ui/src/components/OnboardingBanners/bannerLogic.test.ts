import type { AgenticToolName, AuthCheckStatus, User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  BannerDecision,
  type BannerDecisionInput,
  credentialFingerprint,
  credentialRemediationTarget,
  decideBanner,
  hasConfiguredCredentialFor,
  ProbeState,
  probeableTools,
  resolvedCredentialOwner,
  resolveGovernedProbeAgent,
  resolveProbeState,
} from './bannerLogic';

const baseInput: BannerDecisionInput = {
  onboardingCompleted: true,
  hasLlm: false,
  probeState: ProbeState.Unknown,
  hasWorkingAlternative: false,
  canManageMcp: true,
  mcpServerCount: 0,
  gatewayChannelCount: 0,
  integrationsHydrated: true,
  integrationsBannerDismissed: false,
  credentialWarningDismissed: false,
  softWarningDismissed: false,
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

  it('a dismissed credential warning stays hidden without becoming an integrations prompt', () => {
    expect(
      decideBanner({
        ...baseInput,
        hasLlm: true,
        probeState: ProbeState.Unauthenticated,
        credentialWarningDismissed: true,
      })
    ).toBe(BannerDecision.None);
  });
});

describe('decideBanner — multi-tool softening', () => {
  it('softens to the partial-AI notice when the governed tool is broken but another works', () => {
    expect(
      decideBanner({
        ...baseInput,
        hasLlm: true,
        probeState: ProbeState.Unauthenticated,
        hasWorkingAlternative: true,
      })
    ).toBe(BannerDecision.PartialAi);
  });

  it('keeps the amber warning when NO credentialed tool passes its probe', () => {
    expect(
      decideBanner({
        ...baseInput,
        hasLlm: true,
        probeState: ProbeState.Unauthenticated,
        hasWorkingAlternative: false,
      })
    ).toBe(BannerDecision.KeyInvalid);
  });

  it('lets the partial-AI notice be dismissed freely and independently of the amber snooze', () => {
    expect(
      decideBanner({
        ...baseInput,
        hasLlm: true,
        probeState: ProbeState.Unauthenticated,
        hasWorkingAlternative: true,
        softWarningDismissed: true,
        // A dismissed amber warning must NOT hide a live partial notice, and vice versa.
        credentialWarningDismissed: false,
      })
    ).toBe(BannerDecision.None);
    expect(
      decideBanner({
        ...baseInput,
        hasLlm: true,
        probeState: ProbeState.Unauthenticated,
        hasWorkingAlternative: true,
        credentialWarningDismissed: true,
        softWarningDismissed: false,
      })
    ).toBe(BannerDecision.PartialAi);
  });

  it('never softens without positive proof: an Unknown governed probe shows nothing', () => {
    expect(
      decideBanner({
        ...baseInput,
        hasLlm: true,
        probeState: ProbeState.Unknown,
        hasWorkingAlternative: true,
      })
    ).not.toBe(BannerDecision.PartialAi);
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

describe('resolveGovernedProbeAgent — matches session creation', () => {
  const setting = (tool: AgenticToolName, enabled: boolean) => ({
    tool,
    revision: 0,
    deployment_available: true,
    enabled,
    resolution_policy: 'user_preferred' as const,
    inline_configuration_allowed: true,
    connection: {},
  });

  it('prefers the explicit primary coding agent', () => {
    expect(
      resolveGovernedProbeAgent(
        asUser({
          primary_agentic_tool: 'gemini',
          agentic_tools: { codex: { OPENAI_API_KEY: 'sk' } },
        }),
        new Map([['gemini', setting('gemini', true)]])
      )
    ).toBe('gemini');
  });

  it('does not let another tool credential/default override the creation default', () => {
    const settings = new Map([
      ['claude-code', setting('claude-code', true)],
      ['codex', setting('codex', true)],
    ]);
    expect(
      resolveGovernedProbeAgent(
        asUser({
          agentic_tools: { codex: { OPENAI_API_KEY: 'sk' } },
          default_agentic_config: { codex: {} },
        }),
        settings
      )
    ).toBe('claude-code');
  });

  it('uses the canonical creation order when the preferred tools are disabled', () => {
    const settings = new Map([
      ['claude-code', setting('claude-code', false)],
      ['codex', setting('codex', false)],
      ['gemini', setting('gemini', false)],
      ['opencode', setting('opencode', true)],
      ['cursor', setting('cursor', true)],
      ['copilot', setting('copilot', true)],
    ]);
    expect(resolveGovernedProbeAgent(asUser({}), settings)).toBe('opencode');
  });
});

describe('probeableTools — governed default plus credentialed alternatives', () => {
  const setting = (tool: AgenticToolName, enabled: boolean) => ({
    tool,
    revision: 0,
    deployment_available: true,
    enabled,
    resolution_policy: 'user_preferred' as const,
    inline_configuration_allowed: true,
    connection: {},
  });

  it('probes only the governed tool when no other tool is credentialed', () => {
    expect(
      probeableTools(
        asUser({ primary_agentic_tool: 'claude-code' }),
        new Map([['claude-code', setting('claude-code', true)]])
      )
    ).toEqual(['claude-code']);
  });

  it('adds each enabled, credentialed alternative after the governed tool', () => {
    const tools = probeableTools(
      asUser({
        primary_agentic_tool: 'claude-code',
        agentic_tools: { codex: { OPENAI_API_KEY: true } },
      }),
      new Map([
        ['claude-code', setting('claude-code', true)],
        ['codex', setting('codex', true)],
      ])
    );
    expect(tools[0]).toBe('claude-code');
    expect(tools).toContain('codex');
  });

  it('never probes a disabled alternative even if it has a credential', () => {
    const tools = probeableTools(
      asUser({
        primary_agentic_tool: 'claude-code',
        agentic_tools: { codex: { OPENAI_API_KEY: true } },
      }),
      new Map([
        ['claude-code', setting('claude-code', true)],
        ['codex', setting('codex', false)],
      ])
    );
    expect(tools).toEqual(['claude-code']);
  });
});

describe('credentialFingerprint — per-tool change detection', () => {
  const base = asUser({
    agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
    agentic_auth_methods: { 'claude-code': 'api_key' },
  });

  it('is stable when an unrelated tool credential changes', () => {
    const before = credentialFingerprint(base, 'claude-code');
    const after = credentialFingerprint(
      asUser({
        agentic_tools: {
          'claude-code': { ANTHROPIC_API_KEY: true },
          codex: { OPENAI_API_KEY: true },
        },
        agentic_auth_methods: { 'claude-code': 'api_key' },
      }),
      'claude-code'
    );
    expect(after).toBe(before);
  });

  it('changes when the tool loses its stored credential', () => {
    expect(credentialFingerprint(asUser({ agentic_tools: {} }), 'claude-code')).not.toBe(
      credentialFingerprint(base, 'claude-code')
    );
  });

  it('changes when the tenant revision advances', () => {
    const withRevision = (revision: number) => ({
      tool: 'claude-code' as const,
      revision,
      deployment_available: true,
      enabled: true,
      resolution_policy: 'tenant_preferred' as const,
      inline_configuration_allowed: true,
      connection: { ANTHROPIC_API_KEY: { configured: true } },
    });
    expect(credentialFingerprint(base, 'claude-code', withRevision(1))).not.toBe(
      credentialFingerprint(base, 'claude-code', withRevision(2))
    );
  });
});

describe('resolveProbeState — selected tool only', () => {
  const collect = (map: Partial<Record<AgenticToolName, AuthCheckStatus>>) => {
    const calls: AgenticToolName[] = [];
    const checkStatus = (tool: AgenticToolName): Promise<AuthCheckStatus> => {
      calls.push(tool);
      return Promise.resolve(map[tool] ?? 'unauthenticated');
    };
    return { calls, checkStatus };
  };

  it('returns Authenticated on a working selected tool', async () => {
    const { calls, checkStatus } = collect({ codex: 'authenticated' });
    expect(await resolveProbeState(checkStatus, 'codex')).toBe(ProbeState.Authenticated);
    expect(calls).toEqual(['codex']);
  });

  it('returns Unknown (fail safe) when the selected probe is unknown', async () => {
    const { checkStatus } = collect({ 'claude-code': 'unknown' });
    expect(await resolveProbeState(checkStatus, 'claude-code')).toBe(ProbeState.Unknown);
  });

  it('does not collapse another agent failure into the selected agent verdict', async () => {
    const { calls, checkStatus } = collect({
      'claude-code': 'authenticated',
      codex: 'unauthenticated',
    });
    expect(await resolveProbeState(checkStatus, 'claude-code')).toBe(ProbeState.Authenticated);
    expect(calls).toEqual(['claude-code']);
  });

  it('clears the No-AI banner for a native subscription login with no stored key', async () => {
    // The in-app Claude OAuth sign-in removes any pasted API key, while the
    // selected Claude probe still reports the native login as authenticated.
    const { checkStatus } = collect({ 'claude-code': 'authenticated' });
    const probeState = await resolveProbeState(checkStatus, 'claude-code');
    expect(probeState).toBe(ProbeState.Authenticated);
    expect(decideBanner({ ...baseInput, hasLlm: false, probeState })).not.toBe(BannerDecision.NoAi);
  });

  it('returns Unauthenticated only on a positive rejection for the selected tool', async () => {
    const { calls, checkStatus } = collect({ gemini: 'unauthenticated' });
    expect(await resolveProbeState(checkStatus, 'gemini')).toBe(ProbeState.Unauthenticated);
    expect(calls).toEqual(['gemini']);
  });
});

describe('hasConfiguredCredentialFor — active policy route', () => {
  const settings = (
    resolution_policy: 'user_required' | 'user_preferred' | 'tenant_preferred' | 'tenant_required',
    tenantConfigured: boolean
  ) => ({
    tool: 'claude-code' as const,
    deployment_available: true,
    enabled: true,
    inline_configuration_allowed: true,
    resolution_policy,
    connection: { ANTHROPIC_API_KEY: { configured: tenantConfigured } },
  });

  it('ignores inactive Claude API keys while subscription auth is selected', () => {
    const user = asUser({
      agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
      agentic_auth_methods: { 'claude-code': 'subscription' },
    });
    expect(hasConfiguredCredentialFor(user, 'claude-code', settings('user_required', false))).toBe(
      false
    );
  });

  it('does not count a user key under tenant-required policy', () => {
    const user = asUser({
      agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
      agentic_auth_methods: { 'claude-code': 'api_key' },
    });
    expect(
      hasConfiguredCredentialFor(user, 'claude-code', settings('tenant_required', false))
    ).toBe(false);
  });

  it('routes preferred policies to the owner that actually supplies the connection', () => {
    const user = asUser({
      agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
      agentic_auth_methods: { 'claude-code': 'api_key' },
    });
    expect(resolvedCredentialOwner(user, 'claude-code', settings('tenant_preferred', false))).toBe(
      'user'
    );
    expect(
      resolvedCredentialOwner(asUser({}), 'claude-code', settings('user_preferred', true))
    ).toBe('tenant');
  });

  it('separates effective tenant ownership from a user-preferred member override', () => {
    expect(credentialRemediationTarget('tenant', 'user_preferred', false)).toBe('user');
    expect(credentialRemediationTarget('tenant', 'tenant_preferred', false)).toBe(
      'workspace-admin'
    );
    expect(credentialRemediationTarget('tenant', 'tenant_required', false)).toBe('workspace-admin');
    expect(credentialRemediationTarget('tenant', 'user_preferred', true)).toBe('tenant');
    expect(credentialRemediationTarget('user', 'tenant_preferred', false)).toBe('user');
  });
});
