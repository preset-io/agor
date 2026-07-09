import type { User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  type BannerDecisionInput,
  decideBanner,
  hasAnyLlmKey,
  resolveProbeAgent,
} from './bannerLogic';

const baseInput: BannerDecisionInput = {
  onboardingCompleted: true,
  hasLlm: false,
  probeState: 'unknown',
  canManageMcp: true,
  mcpServerCount: 0,
  gatewayChannelCount: 0,
  integrationsBannerDismissed: false,
};

const asUser = (partial: Partial<User>): User => partial as User;

describe('decideBanner — fail-safe amber banners', () => {
  it('no DB key but probe authenticated → does NOT show the "No AI" banner (bug 1 fix)', () => {
    // The claude /login / executor-filesystem case: hasLlm is false but the tool is reachable.
    expect(decideBanner({ ...baseInput, hasLlm: false, probeState: 'authenticated' })).not.toBe(
      'no-ai'
    );
  });

  it('probe unknown (loading) → shows neither amber banner', () => {
    expect(decideBanner({ ...baseInput, hasLlm: false, probeState: 'unknown' })).toBe('none');
    expect(decideBanner({ ...baseInput, hasLlm: true, probeState: 'unknown' })).not.toBe(
      'key-invalid'
    );
  });

  it('probe unauthenticated + no DB key → "No AI" banner', () => {
    expect(decideBanner({ ...baseInput, hasLlm: false, probeState: 'unauthenticated' })).toBe(
      'no-ai'
    );
  });

  it('probe unauthenticated + DB key present → "key invalid" banner', () => {
    expect(decideBanner({ ...baseInput, hasLlm: true, probeState: 'unauthenticated' })).toBe(
      'key-invalid'
    );
  });
});

describe('decideBanner — integrations banner', () => {
  it('has a gateway channel, zero MCP servers → does NOT show integrations banner (bug 2 fix)', () => {
    expect(
      decideBanner({
        ...baseInput,
        probeState: 'authenticated',
        mcpServerCount: 0,
        gatewayChannelCount: 1,
      })
    ).toBe('none');
  });

  it('AI ok + zero MCP + zero gateway channels → shows integrations banner', () => {
    expect(
      decideBanner({
        ...baseInput,
        probeState: 'authenticated',
        mcpServerCount: 0,
        gatewayChannelCount: 0,
      })
    ).toBe('integrations');
  });

  it('has an MCP server, zero gateway channels → does NOT show integrations banner', () => {
    expect(decideBanner({ ...baseInput, probeState: 'authenticated', mcpServerCount: 1 })).toBe(
      'none'
    );
  });

  it('is suppressed while dismissed, when AI cannot be confirmed, or when MCP is unmanageable', () => {
    expect(
      decideBanner({ ...baseInput, probeState: 'authenticated', integrationsBannerDismissed: true })
    ).toBe('none');
    // Probe still loading and no DB key → AI not confirmed ok → no teal banner yet.
    expect(decideBanner({ ...baseInput, probeState: 'unknown' })).toBe('none');
    expect(decideBanner({ ...baseInput, probeState: 'authenticated', canManageMcp: false })).toBe(
      'none'
    );
  });

  it('shows the teal banner for a DB-key user even while the probe is still loading', () => {
    expect(decideBanner({ ...baseInput, hasLlm: true, probeState: 'unknown' })).toBe(
      'integrations'
    );
  });
});

describe('decideBanner — onboarding gate', () => {
  it('never shows any banner before onboarding completes', () => {
    expect(
      decideBanner({ ...baseInput, onboardingCompleted: false, probeState: 'unauthenticated' })
    ).toBe('none');
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

  it('falls back to claude-code when nothing is known', () => {
    expect(resolveProbeAgent(null)).toBe('claude-code');
    expect(resolveProbeAgent(asUser({}))).toBe('claude-code');
  });
});

describe('other-tool false positives (Cursor / Copilot / OpenCode)', () => {
  it('a Cursor-connected user probes cursor and, once authenticated, sees no "No AI" banner', () => {
    const user = asUser({ agentic_tools: { cursor: { CURSOR_API_KEY: 'k' } } });
    expect(resolveProbeAgent(user)).toBe('cursor');
    // hasLlm is true (stored key) → an unauthenticated probe would word as key-invalid,
    // but an authenticated probe shows no amber banner at all.
    expect(decideBanner({ ...baseInput, hasLlm: true, probeState: 'authenticated' })).not.toBe(
      'key-invalid'
    );
  });

  it('an OpenCode user (no DB key) probes opencode; authenticated → no "No AI" banner', () => {
    const user = asUser({ default_agentic_config: { opencode: {} } });
    expect(resolveProbeAgent(user)).toBe('opencode');
    expect(hasAnyLlmKey(user)).toBe(false);
    expect(decideBanner({ ...baseInput, hasLlm: false, probeState: 'authenticated' })).not.toBe(
      'no-ai'
    );
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
});
