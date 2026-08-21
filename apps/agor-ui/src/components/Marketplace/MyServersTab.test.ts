import type { MCPMarketplaceServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { nextToolPermissions } from './MyServersTab';

const server = {
  tools: [
    { name: 'default_tool', description: '', permission: 'default' },
    { name: 'denied_tool', description: '', permission: 'deny' },
    { name: 'asked_tool', description: '', permission: 'ask' },
    { name: 'allowed_tool', description: '', permission: 'allow' },
  ],
} as MCPMarketplaceServer;

describe('Marketplace tool controls', () => {
  it('writes deny for Off while preserving explicit Ask choices', () => {
    expect(nextToolPermissions(server, 'default_tool', false)).toEqual({
      default_tool: 'deny',
      denied_tool: 'deny',
      asked_tool: 'ask',
      allowed_tool: 'allow',
    });
  });

  it('removes an override for On instead of persisting allow', () => {
    expect(nextToolPermissions(server, 'denied_tool', true)).toEqual({
      asked_tool: 'ask',
      allowed_tool: 'allow',
    });
  });
});
