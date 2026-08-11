import { describe, expect, it, vi } from 'vitest';
import {
  boardPresenceRoomName,
  emitHaNativeSocketEvent,
  HA_NATIVE_SOCKET_EVENT_INVENTORY,
  tenantChannelName,
  tenantUserChannelName,
} from './routing';

describe('realtime routing boundary', () => {
  it('centralizes tenant room and channel names', () => {
    expect(tenantChannelName('tenant-a')).toBe('tenant:tenant-a');
    expect(tenantUserChannelName('tenant-a', 'user-a')).toBe('tenant:tenant-a:user:user-a');
    expect(boardPresenceRoomName('tenant-a', 'board-a')).toBe(
      'tenant:tenant-a:board:board-a:presence'
    );
  });

  it('encodes room delimiters so tenant and resource namespaces cannot collide', () => {
    expect(tenantChannelName('a:board:b:presence')).toBe('tenant:a%3Aboard%3Ab%3Apresence');
    expect(tenantChannelName('a:board:b:presence')).not.toBe(boardPresenceRoomName('a', 'b'));
    expect(tenantUserChannelName('a:user:b', 'c')).not.toBe(tenantUserChannelName('a', 'b:user:c'));
    expect(tenantChannelName('a%3Aboard')).toBe('tenant:a%253Aboard');
  });

  it('emits only through the explicit native HA event inventory', () => {
    expect(HA_NATIVE_SOCKET_EVENT_INVENTORY).toEqual([
      'cursor-moved',
      'cursor-left',
      'presence-updated',
      'repo:cloneError',
      'oauth:completed',
      'oauth:disconnected',
    ]);
    const target = { emit: vi.fn() };
    const emitter = { to: vi.fn(() => target) };
    emitHaNativeSocketEvent(emitter, boardPresenceRoomName('tenant-a', 'board-a'), 'cursor-left', {
      userId: 'user-a',
      boardId: '019fe5bc-65cf-7095-b160-454363604446' as never,
      timestamp: 1,
    });
    expect(emitter.to).toHaveBeenCalledWith('tenant:tenant-a:board:board-a:presence');
    expect(target.emit).toHaveBeenCalledWith('cursor-left', {
      userId: 'user-a',
      boardId: '019fe5bc-65cf-7095-b160-454363604446',
      timestamp: 1,
    });
  });

  it('rejects unqualified rooms at the typed HA boundary', () => {
    const emitter = { to: vi.fn(() => ({ emit: vi.fn() })) };
    // This assertion is compile-time coverage: removing the tenant room brand
    // makes the @ts-expect-error unused and fails the repository typecheck.
    // @ts-expect-error native cross-replica rooms must be tenant-qualified
    emitHaNativeSocketEvent(emitter, 'board-a', 'cursor-left', {
      userId: 'user-a',
      boardId: '019fe5bc-65cf-7095-b160-454363604446' as never,
      timestamp: 1,
    });
  });
});
