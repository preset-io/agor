import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { safeOutboundFetch, UnsafeOutboundUrlError } from './safe-outbound-fetch';

describe('safe outbound connection-time DNS policy', () => {
  beforeEach(() => lookupMock.mockReset());

  it('rejects a mixed public/private DNS answer before opening a connection', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.23.45.67', family: 4 },
    ]);

    await expect(safeOutboundFetch('https://mixed-answer.example/token')).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError
    );
    expect(lookupMock).toHaveBeenCalledWith('mixed-answer.example', {
      all: true,
      verbatim: true,
    });
  });

  it('rejects a DNS answer that changes entirely to private space', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(
      safeOutboundFetch('https://rebound.example/latest/meta-data')
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });
});
