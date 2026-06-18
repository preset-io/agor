import { describe, expect, it } from 'vitest';
import {
  formatGatewayFollowUpRoutingMessage,
  formatGatewayMarkdownSessionReference,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemMessage,
} from './system-message';

const sessionId = '019e6fca-0000-7000-8000-000000000000';
const sessionShortId = '019e6fca0000700080000000';
const sessionUrl = 'https://agor.sandbox.preset.zone/ui/s/019e6fca/';

describe('formatGatewaySystemMessage', () => {
  it('formats Slack session-created messages without markdown emphasis wrappers', () => {
    expect(formatGatewaySystemMessage('slack', `Session created: ${sessionUrl}`)).toBe(
      `Agor: Session created: <${sessionUrl}|View session>`
    );
  });

  it('keeps generic Slack system messages plain', () => {
    expect(formatGatewaySystemMessage('slack', 'Creating new codex session...')).toBe(
      'Agor: Creating new codex session...'
    );
  });

  it('escapes generic Slack system messages with the shared Slack markdown formatter', () => {
    expect(formatGatewaySystemMessage('slack', 'A & B < C')).toBe('Agor: A &amp; B &lt; C');
  });

  it('formats Slack follow-up routing messages with a clickable session link', () => {
    const text = formatGatewayFollowUpRoutingMessage(sessionId, sessionUrl);

    expect(text).toBe(
      `Follow-up received — routing to [session ${sessionShortId}](${sessionUrl})...`
    );
    expect(formatGatewaySystemMessage('slack', text)).toBe(
      `Agor: Follow-up received — routing to <${sessionUrl}|session ${sessionShortId}>...`
    );
  });

  it('falls back to a short session ID when no session URL is available', () => {
    expect(formatGatewayMarkdownSessionReference(sessionId, null)).toBe(
      `session ${sessionShortId}`
    );
    expect(formatGatewayFollowUpRoutingMessage(sessionId, null)).toBe(
      `Follow-up received — routing to session ${sessionShortId}...`
    );
  });

  it('centralizes created-session fallback wording', () => {
    expect(formatGatewaySessionCreatedMessage(sessionId, sessionUrl)).toBe(
      `Session created: ${sessionUrl}`
    );
    expect(formatGatewaySessionCreatedMessage(sessionId, null)).toBe(
      `Session ${sessionShortId} created, sending prompt to agent...`
    );
  });

  it('does not apply Slack link syntax to non-Slack channels', () => {
    expect(formatGatewaySystemMessage('github', `Session created: ${sessionUrl}`)).toBe(
      `Agor: Session created: ${sessionUrl}`
    );
  });
});
