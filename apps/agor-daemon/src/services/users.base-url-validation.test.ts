import type { AgorConfig } from '@agor/core/config';
import { BadRequest } from '@agor/core/feathers';
import { describe, expect, it } from 'vitest';
import { validateAgenticBaseUrls } from './users';

// Multi-tenant (required_from_auth) → shared daemon → public-only egress enforced.
const enforced = { multi_tenancy: { mode: 'required_from_auth' } } as AgorConfig;
// Default (simple + static + standalone) → trusted-local → permissive.
const trustedLocal = {} as AgorConfig;

describe('validateAgenticBaseUrls', () => {
  it('rejects a private or metadata base URL on an enforced deployment', async () => {
    await expect(
      validateAgenticBaseUrls(
        { 'claude-code': { ANTHROPIC_BASE_URL: 'https://169.254.169.254' } } as never,
        enforced
      )
    ).rejects.toBeInstanceOf(BadRequest);
    await expect(
      validateAgenticBaseUrls(
        { codex: { OPENAI_BASE_URL: 'https://10.0.0.5:8080/v1' } } as never,
        enforced
      )
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('rejects a non-HTTPS base URL on an enforced deployment', async () => {
    await expect(
      validateAgenticBaseUrls(
        { 'claude-code': { ANTHROPIC_BASE_URL: 'http://api.anthropic.com' } } as never,
        enforced
      )
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('accepts a public HTTPS base URL on an enforced deployment', async () => {
    await expect(
      validateAgenticBaseUrls(
        { 'claude-code': { ANTHROPIC_BASE_URL: 'https://93.184.216.34/v1' } } as never,
        enforced
      )
    ).resolves.toBeUndefined();
  });

  it('allows a local or LAN endpoint on a trusted-local deployment', async () => {
    await expect(
      validateAgenticBaseUrls(
        { 'claude-code': { ANTHROPIC_BASE_URL: 'http://localhost:1234' } } as never,
        trustedLocal
      )
    ).resolves.toBeUndefined();
    await expect(
      validateAgenticBaseUrls(
        { codex: { OPENAI_BASE_URL: 'http://192.168.1.50:8080/v1' } } as never,
        trustedLocal
      )
    ).resolves.toBeUndefined();
  });

  it('rejects a non-http(s) base URL even on a trusted-local deployment', async () => {
    await expect(
      validateAgenticBaseUrls(
        { 'claude-code': { ANTHROPIC_BASE_URL: 'file:///etc/passwd' } } as never,
        trustedLocal
      )
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('ignores omitted, empty, or cleared base URLs', async () => {
    await expect(
      validateAgenticBaseUrls(
        { 'claude-code': { ANTHROPIC_API_KEY: 'sk-test' } } as never,
        enforced
      )
    ).resolves.toBeUndefined();
    await expect(
      validateAgenticBaseUrls({ 'claude-code': { ANTHROPIC_BASE_URL: null } } as never, enforced)
    ).resolves.toBeUndefined();
    await expect(
      validateAgenticBaseUrls({ 'claude-code': { ANTHROPIC_BASE_URL: '   ' } } as never, enforced)
    ).resolves.toBeUndefined();
  });
});
