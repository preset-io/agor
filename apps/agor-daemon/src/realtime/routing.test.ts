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

  it('emits only through the explicit native HA event inventory', () => {
    expect(HA_NATIVE_SOCKET_EVENT_INVENTORY).toEqual([
      'cursor-moved',
      'cursor-left',
      'presence-updated',
      'repo:cloneError',
    ]);
    const target = { emit: vi.fn() };
    emitHaNativeSocketEvent(target, 'cursor-left', {
      userId: 'user-a',
      boardId: '019fe5bc-65cf-7095-b160-454363604446' as never,
      timestamp: 1,
    });
    expect(target.emit).toHaveBeenCalledWith('cursor-left', {
      userId: 'user-a',
      boardId: '019fe5bc-65cf-7095-b160-454363604446',
      timestamp: 1,
    });
  });
});
