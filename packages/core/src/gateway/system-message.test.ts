import { describe, expect, it } from 'vitest';
import { formatGatewaySystemMessage } from './system-message';

describe('formatGatewaySystemMessage', () => {
  it('formats Slack session-created messages without markdown emphasis wrappers', () => {
    expect(
      formatGatewaySystemMessage(
        'slack',
        'Session created: https://agor.sandbox.preset.zone/ui/s/019e6fca/'
      )
    ).toBe(
      '[system] Session created: <https://agor.sandbox.preset.zone/ui/s/019e6fca/|View session>'
    );
  });

  it('keeps generic Slack system messages plain', () => {
    expect(formatGatewaySystemMessage('slack', 'Creating new codex session...')).toBe(
      '[system] Creating new codex session...'
    );
  });

  it('escapes generic Slack system messages with the shared Slack markdown formatter', () => {
    expect(formatGatewaySystemMessage('slack', 'A & B < C')).toBe('[system] A &amp; B &lt; C');
  });

  it('does not apply Slack link syntax to non-Slack channels', () => {
    expect(
      formatGatewaySystemMessage(
        'github',
        'Session created: https://agor.sandbox.preset.zone/ui/s/019e6fca/'
      )
    ).toBe('[system] Session created: https://agor.sandbox.preset.zone/ui/s/019e6fca/');
  });
});
