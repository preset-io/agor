import { SOCKET_IO_MAX_BUFFER_SIZE_BYTES } from '@agor/core/config';
import { describe, expect, it } from 'vitest';

describe('executor transport budget', () => {
  const BUDGET = SOCKET_IO_MAX_BUFFER_SIZE_BYTES - 200_000;

  it('derives a budget below the shared Socket.IO ceiling', () => {
    expect(BUDGET).toBe(800_000);
    expect(BUDGET).toBeLessThan(SOCKET_IO_MAX_BUFFER_SIZE_BYTES);
  });
});
