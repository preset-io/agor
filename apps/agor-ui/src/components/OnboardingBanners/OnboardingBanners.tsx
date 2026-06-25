/**
 * OnboardingBanners — persistent banners shown after onboarding if steps were skipped.
 *
 * AI banner: shown when user has completed onboarding but has no LLM key configured.
 * Integrations banner: shown when AI is configured but no MCP servers are connected.
 *
 * Only one banner shows at a time; AI banner takes priority.
 */

import type { User } from '@agor-live/client';
import { ApiOutlined } from '@ant-design/icons';
import { Button, Tag } from 'antd';
import type { WizardStep } from '../OnboardingWizard';

export interface OnboardingBannersProps {
  user: User | null | undefined;
  /** Total number of MCP servers configured for this user/instance. */
  mcpServerCount: number;
  /** Opens the onboarding wizard at the given step. */
  onOpenWizardAtStep: (step: WizardStep) => void;
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
    user.env_vars?.OPENAI_API_KEY ||
    user.env_vars?.GEMINI_API_KEY
  );
}

export function OnboardingBanners({
  user,
  mcpServerCount,
  onOpenWizardAtStep,
}: OnboardingBannersProps) {
  if (!user?.onboarding_completed) return null;

  const hasLlm = hasAnyLlmKey(user);
  const showAiBanner = !hasLlm;
  const showIntegrationsBanner = !showAiBanner && mcpServerCount === 0;

  if (!showAiBanner && !showIntegrationsBanner) return null;

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
          ⚠️ No AI connected — Agor can't do anything useful without one.
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
            onClick={() => onOpenWizardAtStep('llm')}
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

  return (
    <div
      style={{
        background: 'rgba(99,102,241,0.1)',
        borderBottom: '1px solid rgba(99,102,241,0.5)',
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
          color: '#c7d2fe',
          fontSize: 13,
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Tag icon={<ApiOutlined />} color="default" style={{ margin: 0, fontSize: 12 }}>
          {mcpServerCount} MCP {mcpServerCount === 1 ? 'server' : 'servers'}
        </Tag>
        Connect tools to unlock your AI's full potential.
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          type="text"
          size="small"
          onClick={() => onOpenWizardAtStep('integrations')}
          style={{ color: '#94a3b8', fontSize: 12 }}
        >
          Maybe later
        </Button>
        <Button
          size="small"
          onClick={() => onOpenWizardAtStep('integrations')}
          style={{
            background: '#6366f1',
            borderColor: '#6366f1',
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
