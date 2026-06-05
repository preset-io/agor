import { describe, expect, it } from 'vitest';
import {
  isUrlShapedManagedEnvCommand,
  normalizeManagedEnvWebhookUrl,
  redactManagedEnvWebhookUrlForAudit,
  resolveManagedEnvCommandExecution,
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

  it('redacts query strings for audit logging', () => {
    expect(redactManagedEnvWebhookUrlForAudit('https://hooks.example.com/start?token=secret')).toBe(
      'https://hooks.example.com/start?[redacted]'
    );
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
