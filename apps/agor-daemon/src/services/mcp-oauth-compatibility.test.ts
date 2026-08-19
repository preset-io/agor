import type { MCPAuth, MCPSource } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { resolveMCPOAuthCompatibilityMode } from './mcp-oauth-compatibility.js';

function server(source: MCPSource, compatibility?: 'strict' | 'legacy') {
  return {
    source,
    ...(source === 'catalog' ? { catalog_entry_name: 'com.example/provider' } : {}),
    auth: {
      type: 'oauth',
      ...(compatibility ? { oauth_compatibility_mode: compatibility } : {}),
    } satisfies MCPAuth,
  };
}

describe('resolveMCPOAuthCompatibilityMode', () => {
  it('uses the bounded interoperability profile only for an unstated catalog install', () => {
    expect(resolveMCPOAuthCompatibilityMode(server('catalog'))).toBe('marketplace');
  });

  it('retains explicit strict and legacy catalog opt-ins', () => {
    expect(resolveMCPOAuthCompatibilityMode(server('catalog', 'strict'))).toBe('strict');
    expect(resolveMCPOAuthCompatibilityMode(server('catalog', 'legacy'))).toBe('legacy');
  });

  it('does not trust a caller-forgeable source value without the protected catalog stamp', () => {
    expect(resolveMCPOAuthCompatibilityMode({ source: 'catalog', auth: { type: 'oauth' } })).toBe(
      'strict'
    );
  });

  it.each(['user', 'imported', 'agor'] as const)(
    'keeps the general %s server default strict',
    (source) => {
      expect(resolveMCPOAuthCompatibilityMode(server(source))).toBe('strict');
    }
  );
});
