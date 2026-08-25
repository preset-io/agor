import type { Application } from '@agor/core/feathers';
import type { HookContext, UserID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { tenantUserChannelName } from '../realtime/routing';
import {
  captureMarketplaceInvalidationTargets,
  emitMarketplaceInvalidation,
  publishCapturedMarketplaceInvalidation,
} from './marketplace-invalidation';

describe('Marketplace invalidation routing', () => {
  it('targets each affected principal in the authoritative tenant with no metadata payload', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const app = { io: { to } } as unknown as Application & { io: { to: typeof to } };

    emitMarketplaceInvalidation(app, 'tenant-a', ['alice', 'removed-member', 'alice']);

    expect(to.mock.calls.map(([room]) => room)).toEqual([
      tenantUserChannelName('tenant-a', 'alice'),
      tenantUserChannelName('tenant-a', 'removed-member'),
    ]);
    expect(emit).toHaveBeenCalledTimes(2);
    for (const [event, payload] of emit.mock.calls) {
      expect(event).toBe('marketplace:invalidated');
      expect(payload).toEqual({});
      expect(JSON.stringify(payload)).not.toMatch(/branch|server|credential|user|tenant/i);
    }
    expect(to).not.toHaveBeenCalledWith(expect.stringContaining('tenant-b'));
  });

  it('fails closed without trusted tenant identity', () => {
    const to = vi.fn(() => ({ emit: vi.fn() }));
    const app = { io: { to } } as unknown as Application & { io: { to: typeof to } };
    emitMarketplaceInvalidation(app, undefined, ['alice']);
    expect(to).not.toHaveBeenCalled();
  });

  it('retains removed owners/group members by snapshotting before the visibility write', async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const app = { io: { to } } as unknown as Application & { io: { to: typeof to } };
    const removedOwner = 'removed-owner' as UserID;
    const removedGroupMember = 'removed-group-member' as UserID;
    const users = {
      listUserIds: vi.fn(async () => [removedOwner, removedGroupMember]),
    };
    const context = {
      params: { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } },
    } as HookContext;

    await captureMarketplaceInvalidationTargets(context, users, app);
    // The authoritative write has now removed both viewers. Publication uses
    // the captured audience, never a post-write visibility query.
    users.listUserIds.mockResolvedValue([]);
    publishCapturedMarketplaceInvalidation(context, app);

    expect(to).toHaveBeenCalledWith(tenantUserChannelName('tenant-a', removedOwner));
    expect(to).toHaveBeenCalledWith(tenantUserChannelName('tenant-a', removedGroupMember));
    expect(users.listUserIds).toHaveBeenCalledOnce();
  });
});
