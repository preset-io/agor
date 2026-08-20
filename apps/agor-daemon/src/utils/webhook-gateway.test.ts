import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authenticateWebhook,
  renderWebhookPrompt,
  validateWebhookConfig,
} from './webhook-gateway.js';

describe('webhook gateway authentication', () => {
  it('accepts a configured header token without requiring a timestamp', () => {
    expect(
      authenticateWebhook({
        config: { webhook_secret: 'secret' },
        headers: { 'x-agor-webhook-token': 'secret' },
        rawBody: Buffer.from('{}'),
      })
    ).toBe(true);
  });

  it('authenticates the exact raw bytes and rejects changed bytes', () => {
    const raw = Buffer.from('{ "issue": 1 }');
    const timestamp = '1787200000';
    const signature = createHmac('sha256', 'secret')
      .update(timestamp)
      .update('.')
      .update(raw)
      .digest('hex');
    const input = {
      config: { auth_mode: 'hmac-sha256', webhook_secret: 'secret' },
      headers: { 'x-agor-timestamp': timestamp, 'x-agor-signature': `sha256=${signature}` },
      now: 1787200000000,
    };
    expect(authenticateWebhook({ ...input, rawBody: raw })).toBe(true);
    expect(authenticateWebhook({ ...input, rawBody: Buffer.from('{"issue":1}') })).toBe(false);
  });

  it('rejects stale HMAC timestamps', () => {
    const rawBody = Buffer.from('{}');
    const signature = createHmac('sha256', 'secret')
      .update('1787200000')
      .update('.')
      .update(rawBody)
      .digest('hex');
    expect(
      authenticateWebhook({
        config: { auth_mode: 'hmac-sha256', webhook_secret: 'secret' },
        headers: { 'x-agor-timestamp': '1787200000', 'x-agor-signature': signature },
        rawBody,
        now: 1787200400000,
      })
    ).toBe(false);
  });
});

describe('webhook prompt rendering', () => {
  it('renders deterministic supported payload variables without evaluating payload templates', () => {
    const rendered = renderWebhookPrompt('Issue {{payload.issue.key}}\n{{payload}}', {
      issue: { key: 'AG-1', text: '{{payload.secret}}' },
    });
    expect(rendered).toContain('Issue AG-1');
    expect(rendered).toContain('{{payload.secret}}');
    expect(rendered).toContain('untrusted external data');
  });
  it('requires a prompt and rejects unsafe header names', () => {
    expect(() =>
      validateWebhookConfig({ prompt_template: '{{payload}}', header_name: 'authorization' })
    ).toThrow(/safe HTTP header/);
  });
});
