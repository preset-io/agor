import type { Board } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { planZoneEntityPlacement } from './zone-placement.js';

describe('zone placement fixed canvas siblings', () => {
  const board = {
    board_id: 'board-a',
    objects: {
      zone: {
        type: 'zone',
        x: 1000,
        y: 1000,
        width: 812,
        height: 812,
        layout: { resize: 'fixed', padding: 20, columnGap: 20, rowGap: 20 },
      },
      artifact: { type: 'artifact', x: 1020, y: 1080, width: 200, height: 100, locked: true },
    },
  } as unknown as Board;
  const params = { provider: 'mcp', tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } };
  it('places newly pinned/created entities clear of locked in-zone artifacts', async () => {
    const find = vi.fn(async () => ({ data: [] }));
    const plan = await planZoneEntityPlacement({ service: () => ({ find }) }, params, {
      board,
      zoneId: 'zone',
      entityWidth: 200,
      entityHeight: 100,
    });
    expect(
      plan.position.x + 200 <= 20 ||
        plan.position.x >= 220 ||
        plan.position.y + 100 <= 80 ||
        plan.position.y >= 180
    ).toBe(true);
    expect(find).toHaveBeenCalledWith(expect.objectContaining(params));
  });
  it('does not grow locked zone frames for automatic pin/create placement', async () => {
    const locked = {
      ...board,
      objects: {
        zone: {
          ...board.objects?.zone,
          locked: true,
          width: 260,
          height: 200,
          layout: { resize: 'both' },
        },
      },
    } as Board;
    const find = vi.fn(async () => ({ data: [] }));
    await expect(
      planZoneEntityPlacement({ service: () => ({ find }) }, params, {
        board: locked,
        zoneId: 'zone',
        entityWidth: 500,
        entityHeight: 300,
      })
    ).rejects.toThrow();
  });
  it('retains the caller tenant context when another tenant cannot read occupants', async () => {
    const otherTenant = {
      provider: 'mcp',
      tenant: { tenant_id: 'tenant-b', source: 'auth_claim' },
    };
    const find = vi.fn(async (received: object) => {
      expect(received).toMatchObject(otherTenant);
      throw new Error('Board not found in caller tenant');
    });
    await expect(
      planZoneEntityPlacement({ service: () => ({ find }) }, otherTenant, {
        board,
        zoneId: 'zone',
        entityWidth: 200,
        entityHeight: 100,
      })
    ).rejects.toThrow('Board not found in caller tenant');
  });
});
