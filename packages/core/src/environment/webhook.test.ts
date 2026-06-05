import { describe, expect, it } from 'vitest';
import {
  isAllowedManagedEnvWebhookUrl,
  isUrlShapedManagedEnvCommand,
  normalizeManagedEnvWebhookUrl,
  redactManagedEnvWebhookUrlForAudit,
  resolveManagedEnvCommandExecution,
  validateManagedEnvLifecyclePolicy,
  validateRenderedManagedEnvUrlFields,
  validateRepoEnvironmentLifecyclePolicy,
} from './webhook.js';

describe('managed environment webhook URL detection', () => {
  it('treats explicit http(s) strings as URL-shaped only', () => {
    expect(isUrlShapedManagedEnvCommand('https://hooks.example.com/start')).toBe(true);
    expect(isUrlShapedManagedEnvCommand('  HTTP://localhost:3000/start')).toBe(true);
    expect(isUrlShapedManagedEnvCommand('hooks.example.com/start')).toBe(false);
    expect(isUrlShapedManagedEnvCommand('docker compose up -d')).toBe(false);
  });

  it('normalizes allowed URLs and rejects credentials or metadata targets', () => {
    expect(normalizeManagedEnvWebhookUrl(' https://Example.com/path ')).toBe(
      'https://example.com/path'
    );
    expect(() => normalizeManagedEnvWebhookUrl('https://user:pass@example.com/hook')).toThrow(
      /must not include URL credentials/
    );
    expect(() => normalizeManagedEnvWebhookUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /blocked/
    );
  });

  it('uses a stricter webhook destination policy than health checks', () => {
    expect(isAllowedManagedEnvWebhookUrl('https://hooks.example.com/start')).toBe(true);
    expect(isAllowedManagedEnvWebhookUrl('http://localhost:3000/start')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://127.0.0.1:3000/start')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://10.0.0.5/start')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://192.168.1.20/start')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://172.16.0.1/start')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://metadata.google.internal/')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://[::ffff:127.0.0.1]/start')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://[::ffff:169.254.169.254]/start')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://[fe90::1]/start')).toBe(false);
    expect(isAllowedManagedEnvWebhookUrl('http://[fea0::1]/start')).toBe(false);
  });

  it('redacts query strings for audit logging', () => {
    expect(redactManagedEnvWebhookUrlForAudit('https://hooks.example.com/start?token=secret')).toBe(
      'https://hooks.example.com/start?[redacted]'
    );
  });
});

describe('managed environment policy validation', () => {
  it('allows shell commands in hybrid mode and URL webhooks in both modes', () => {
    expect(() =>
      validateManagedEnvLifecyclePolicy(
        { start: 'docker compose up -d', stop: 'https://hooks.example.com/stop' },
        'hybrid'
      )
    ).not.toThrow();
    expect(() =>
      validateManagedEnvLifecyclePolicy(
        { start: 'https://hooks.example.com/start', stop: 'https://hooks.example.com/stop' },
        'webhook-only'
      )
    ).not.toThrow();
  });

  it('rejects shell commands in webhook-only repo environments', () => {
    expect(() =>
      validateRepoEnvironmentLifecyclePolicy(
        {
          version: 2,
          default: 'child',
          variants: {
            base: {
              start: 'docker compose up -d',
              stop: 'https://hooks.example.com/stop',
            },
            child: {
              extends: 'base',
              stop: 'https://hooks.example.com/child-stop',
            },
          },
        },
        'webhook-only'
      )
    ).toThrow(/variant "base" start must render to an http\(s\) URL webhook/);
  });

  it('allows unresolved repo lifecycle templates for rendered branch-state validation', () => {
    expect(() =>
      validateRepoEnvironmentLifecyclePolicy(
        {
          version: 2,
          default: 'default',
          variants: {
            default: {
              start: '{{custom.webhook_base}}/start?branch={{branch.name}}',
              stop: 'https://hooks.example.com/stop',
            },
          },
        },
        'webhook-only'
      )
    ).not.toThrow();
  });

  it('validates rendered health and app as URL-only fields', () => {
    expect(() =>
      validateRenderedManagedEnvUrlFields({
        health: 'http://localhost:3000/health',
        app: 'http://localhost:3000',
      })
    ).not.toThrow();
    expect(() => validateRenderedManagedEnvUrlFields({ app: 'javascript:alert(1)' })).toThrow(
      /app URL must use http or https/
    );
    expect(() =>
      validateRenderedManagedEnvUrlFields({ health: 'http://169.254.169.254/latest/meta-data' })
    ).toThrow(/health must render to an allowed http\(s\) URL/);
  });
});

describe('resolveManagedEnvCommandExecution', () => {
  it('preserves shell command execution in default hybrid mode', () => {
    expect(resolveManagedEnvCommandExecution('docker compose up -d', 'hybrid', 'start')).toEqual({
      kind: 'command',
      command: 'docker compose up -d',
    });
  });

  it('uses GET webhook execution for URL-shaped fields in hybrid mode', () => {
    expect(
      resolveManagedEnvCommandExecution(
        'https://hooks.example.com/start?token=secret',
        'hybrid',
        'start'
      )
    ).toEqual({
      kind: 'webhook',
      url: 'https://hooks.example.com/start?token=secret',
    });
  });

  it('rejects non-URL commands in webhook-only mode with a docs pointer', () => {
    expect(() =>
      resolveManagedEnvCommandExecution('docker compose up -d', 'webhook-only', 'start')
    ).toThrow(
      /execution\.managed_envs_execution_mode: webhook-only.*environment-configuration#webhook-only-mode/s
    );
  });
});
