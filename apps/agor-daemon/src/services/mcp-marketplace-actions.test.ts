import type { MCPServerRepository } from '@agor/core/db';
import { Conflict, NotFound } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  MCPMarketplaceRemoveServerService,
  MCPMarketplaceToolPermissionService,
} from './mcp-marketplace-actions';

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const SERVER = '00000000-0000-7000-8000-000000005e7e';
const params = { user: { user_id: ALICE, role: 'admin' } } as AuthenticatedParams;

describe('Marketplace MCP actions', () => {
  it('removes only an owned row that is still unattached at the CAS', async () => {
    const repo = {
      isOwnedBy: vi.fn(async () => true),
      deleteIfUnattached: vi.fn(async () => true),
    } as unknown as MCPServerRepository;
    await expect(
      new MCPMarketplaceRemoveServerService(repo).create({ mcp_server_id: SERVER }, params)
    ).resolves.toEqual({ mcp_server_id: SERVER, removed: true });
    expect(repo.deleteIfUnattached).toHaveBeenCalledWith(SERVER);
  });

  it('reports an attachment won after the overview count without ordinary remove', async () => {
    const repo = {
      isOwnedBy: vi.fn(async () => true),
      deleteIfUnattached: vi.fn(async () => false),
      delete: vi.fn(),
    } as unknown as MCPServerRepository;
    await expect(
      new MCPMarketplaceRemoveServerService(repo).create({ mcp_server_id: SERVER }, params)
    ).rejects.toBeInstanceOf(Conflict);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('does not let an admin act on another owner and exposes no distinction', async () => {
    const repo = {
      isOwnedBy: vi.fn(async () => false),
      deleteIfUnattached: vi.fn(),
    } as unknown as MCPServerRepository;
    await expect(
      new MCPMarketplaceRemoveServerService(repo).create({ mcp_server_id: SERVER }, params)
    ).rejects.toBeInstanceOf(NotFound);
    expect(repo.deleteIfUnattached).not.toHaveBeenCalled();
  });

  it('passes only one tool decision to the atomic repository action', async () => {
    const repo = { setOwnedToolEnabled: vi.fn(async () => true) } as unknown as MCPServerRepository;
    await expect(
      new MCPMarketplaceToolPermissionService(repo).create(
        { mcp_server_id: SERVER, tool_name: 'issues.create', enabled: false },
        params
      )
    ).resolves.toEqual({
      mcp_server_id: SERVER,
      tool_name: 'issues.create',
      permission: 'deny',
    });
    expect(repo.setOwnedToolEnabled).toHaveBeenCalledWith(SERVER, ALICE, 'issues.create', false);
  });
});
