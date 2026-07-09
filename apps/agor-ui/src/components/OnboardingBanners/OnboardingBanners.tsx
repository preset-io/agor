/**
 * OnboardingBanners — persistent banners shown after onboarding if steps were skipped.
 *
 * Priority order (only one shows at a time):
 * 1. AI banner (amber)  — no LLM key configured.
 * 2. Connection invalid banner (amber) — key present but auth check failed.
 * 3. Integrations banner (teal) — AI ok, no MCP servers connected.
 */

import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { Button } from 'antd';
import { useEffect, useState } from 'react';

export interface OnboardingBannersProps {
  user: User | null | undefined;
  /** Total number of MCP servers configured for this user/instance. */
  mcpServerCount: number;
  /** Whether the user can reach the MCP settings tab (service enabled + sufficient role). Gates the integrations banner so its CTA is never a dead-end. */
  canManageMcp: boolean;
  /** Opens the user's personal AI credential settings at the given tool tab. */
  onOpenUserSettings: (tab: string) => void;
  /** Opens workspace settings at the given tab key (used for MCP). */
  onOpenWorkspaceSettings: (tab: string) => void;
  /** Optional auth check — used to detect stored-but-broken keys. */
  onCheckAuth?: (tool: AgenticToolName, apiKey?: string) => Promise<AuthCheckResult>;
  /** Bumped by the parent whenever credentials are saved — forces a re-check even if key presence is unchanged (e.g. key rotation). */
  credentialVersion?: number;
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
    gemini?.GEMINI_API_KEY ||
    user.env_vars?.ANTHROPIC_API_KEY ||
    user.env_vars?.CLAUDE_CODE_OAUTH_TOKEN ||
    user.env_vars?.OPENAI_API_KEY ||
    user.env_vars?.GEMINI_API_KEY
  );
}

function primaryAgentForUser(user: User | null | undefined): AgenticToolName | null {
  if (!user) return null;
  const claude = user.agentic_tools?.['claude-code'];
  const codex = user.agentic_tools?.codex;
  const gemini = user.agentic_tools?.gemini;
  if (
    claude?.ANTHROPIC_API_KEY ||
    claude?.CLAUDE_CODE_OAUTH_TOKEN ||
    user.env_vars?.ANTHROPIC_API_KEY ||
    user.env_vars?.CLAUDE_CODE_OAUTH_TOKEN
  )
    return 'claude-code';
  if (codex?.OPENAI_API_KEY || user.env_vars?.OPENAI_API_KEY) return 'codex';
  if (gemini?.GEMINI_API_KEY || user.env_vars?.GEMINI_API_KEY) return 'gemini';
  return null;
}

export function OnboardingBanners({
  user,
  mcpServerCount,
  canManageMcp,
  onOpenUserSettings,
  onOpenWorkspaceSettings,
  onCheckAuth,
  credentialVersion,
}: OnboardingBannersProps) {
  const [storedKeyInvalid, setStoredKeyInvalid] = useState(false);
  const [integrationsBannerDismissed, setIntegrationsBannerDismissed] = useState(false);

  // Pre-compute user-derived values so the effect captures primitives, not the full user object.
  const onboardingCompleted = !!user?.onboarding_completed;
  const hasLlm = hasAnyLlmKey(user);
  const primaryAgent = primaryAgentForUser(user);

  // Check if the stored LLM key is actually working.
  // Re-runs when the user's key changes or identity changes.
  // Fails open (storedKeyInvalid=false) on network errors — deliberate: avoid false positives.
  // credentialVersion is a trigger-only dep: it re-runs the check when the parent bumps it after a credential save,
  // catching key rotations where presence (hasLlm) and primaryAgent are unchanged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: credentialVersion is an intentional trigger dep
  useEffect(() => {
    if (!onboardingCompleted || !onCheckAuth || !hasLlm || !primaryAgent) {
      setStoredKeyInvalid(false);
      return;
    }
    let cancelled = false;
    onCheckAuth(primaryAgent)
      .then((result) => {
        if (!cancelled) setStoredKeyInvalid(!result.authenticated);
      })
      .catch(() => {
        if (!cancelled) setStoredKeyInvalid(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onboardingCompleted, hasLlm, primaryAgent, onCheckAuth, credentialVersion]);

  if (!onboardingCompleted) return null;

  const showAiBanner = !hasLlm;
  const showKeyInvalidBanner = hasLlm && storedKeyInvalid;
  const showIntegrationsBanner =
    hasLlm &&
    !storedKeyInvalid &&
    canManageMcp &&
    mcpServerCount === 0 &&
    !integrationsBannerDismissed;

  if (!showAiBanner && !showKeyInvalidBanner && !showIntegrationsBanner) return null;

  if (showAiBanner) {
    return (
      <div
        style={{
          background: '#78350f',
          borderBottom: '1px solid #92400e',
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 20,
          paddingRight: 20,
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <span style={{ color: '#fde68a', fontSize: 13, fontWeight: 500 }}>
          ⚡ No AI connected - sessions will open but nothing will run.
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            type="text"
            size="small"
            href="https://agor.live/guide"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#fde68a', borderColor: 'rgba(253,230,138,0.4)', fontSize: 12 }}
          >
            Documentation
          </Button>
          <Button
            size="small"
            onClick={() => onOpenUserSettings(primaryAgent ?? 'claude-code')}
            style={{
              background: '#d97706',
              borderColor: '#d97706',
              color: '#fff',
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            Connect AI
          </Button>
        </div>
      </div>
    );
  }

  if (showKeyInvalidBanner) {
    return (
      <div
        style={{
          background: '#78350f',
          borderBottom: '1px solid #92400e',
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 20,
          paddingRight: 20,
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <span style={{ color: '#fde68a', fontSize: 13, fontWeight: 500 }}>
          Your AI credentials aren&apos;t working. Sessions will fail until you reconnect.
        </span>
        <Button
          size="small"
          onClick={() => onOpenUserSettings(primaryAgent ?? 'claude-code')}
          style={{
            background: '#d97706',
            borderColor: '#d97706',
            color: '#fff',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Reconnect AI
        </Button>
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'rgba(46,154,146,0.1)',
        borderBottom: '1px solid rgba(46,154,146,0.35)',
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 20,
        paddingRight: 20,
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      <span
        style={{
          color: '#7dd3ce',
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        Connect Slack, GitHub, or other tools via MCP to let your AI post updates and track issues.
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          type="text"
          size="small"
          onClick={() => setIntegrationsBannerDismissed(true)}
          style={{ color: '#94a3b8', fontSize: 12 }}
        >
          Maybe later
        </Button>
        <Button
          size="small"
          onClick={() => onOpenWorkspaceSettings('mcp')}
          style={{
            background: '#2e9a92',
            borderColor: '#2e9a92',
            color: '#fff',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Connect tools
        </Button>
      </div>
    </div>
  );
}
