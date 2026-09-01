import { describe, expect, it, vi } from 'vitest';
import {
  boardPresenceAssociationRoomName,
  boardPresenceRoomName,
  emitHaNativeSocketEvent,
  executorTaskRoomName,
  HA_NATIVE_SOCKET_EVENT_INVENTORY,
  sessionStreamRoomName,
  tenantChannelName,
  tenantUserChannelName,
  terminalChannelName,
} from './routing';

describe('realtime routing boundary', () => {
  it('centralizes tenant room and channel names', () => {
    expect(tenantChannelName('tenant-a')).toBe('agor:v2:tenant:dGVuYW50LWE');
    expect(tenantUserChannelName('tenant-a', 'user-a')).toBe(
      'agor:v2:tenant:dGVuYW50LWE:user:dXNlci1h'
    );
    expect(boardPresenceRoomName('tenant-a', 'board-a')).toBe(
      'agor:v2:tenant:dGVuYW50LWE:board:Ym9hcmQtYQ:presence'
    );
    expect(boardPresenceAssociationRoomName('tenant-a', 'board-a')).toBe(
      'agor:v2:tenant:dGVuYW50LWE:board:Ym9hcmQtYQ:presence-association'
    );
  });

  it('keeps adversarial room components injective across tenant boundaries', () => {
    expect(tenantUserChannelName('tenant-a:user:victim', 'suffix')).not.toBe(
      tenantUserChannelName('tenant-a', 'victim:user:suffix')
    );
    expect(sessionStreamRoomName('tenant-a:session-stream:x', 'y')).not.toBe(
      sessionStreamRoomName('tenant-a', 'x:session-stream:y')
    );
    expect(executorTaskRoomName('tenant-a:executor-task:x', 'y')).not.toBe(
      executorTaskRoomName('tenant-a', 'x:executor-task:y')
    );
    expect(terminalChannelName('tenant/a/user/b', 'c', 'd')).not.toBe(
      terminalChannelName('tenant/a', 'b/user/c', 'd')
    );
    expect(boardPresenceAssociationRoomName('tenant-a:board:x', 'y')).not.toBe(
      boardPresenceAssociationRoomName('tenant-a', 'x:board:y')
    );
  });

  it('emits only through the explicit native HA event inventory', () => {
    expect(HA_NATIVE_SOCKET_EVENT_INVENTORY).toEqual([
      'cursor-moved',
      'cursor-left',
      'presence-updated',
      'presence-left',
      'repo:cloneError',
      'oauth:completed',
      'oauth:disconnected',
      'marketplace:invalidated',
    ]);
    const target = { emit: vi.fn() };
    emitHaNativeSocketEvent(target, 'cursor-left', {
      userId: 'user-a',
      presenceId: 'presence-a',
      boardId: '019fe5bc-65cf-7095-b160-454363604446' as never,
      timestamp: 1,
    });
    expect(target.emit).toHaveBeenCalledWith('cursor-left', {
      userId: 'user-a',
      presenceId: 'presence-a',
      boardId: '019fe5bc-65cf-7095-b160-454363604446',
      timestamp: 1,
    });
  });
});
