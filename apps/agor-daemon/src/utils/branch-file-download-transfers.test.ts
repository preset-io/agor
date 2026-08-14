import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BranchFileDownloadTransfers,
  type DownloadTransferScope,
} from './branch-file-download-transfers.js';

const SCOPE: DownloadTransferScope = {
  tenantId: 'tenant-a',
  branchId: 'branch-1',
  filePath: 'big.bin',
  maxBytes: 1024,
};

const PROOF = { tenantId: SCOPE.tenantId, branchId: SCOPE.branchId };

function noopSink() {
  return vi.fn(async () => undefined);
}

describe('BranchFileDownloadTransfers', () => {
  it('mints refs the executor payload schema accepts', async () => {
    const transfers = new BranchFileDownloadTransfers();
    const transfer = transfers.register(SCOPE, noopSink());
    expect(transfer.ref).toMatch(/^dl_[0-9a-f-]{36}$/);
    transfer.cancel();
    await expect(transfer.delivered).rejects.toThrow();
  });

  it('hands the registered sink to a correctly scoped claim', async () => {
    const transfers = new BranchFileDownloadTransfers();
    const sink = noopSink();
    const transfer = transfers.register(SCOPE, sink);

    const claimed = transfers.claim(transfer.ref, PROOF);
    expect(claimed).not.toBeNull();
    expect(claimed?.scope.maxBytes).toBe(1024);

    const body = new PassThrough();
    await claimed?.sink(
      { filename: 'big.bin', mimeType: 'application/octet-stream', size: 3 },
      body
    );
    expect(sink).toHaveBeenCalledOnce();

    claimed?.settle();
    await expect(transfer.delivered).resolves.toBeUndefined();
  });

  it('is single-use, so a replayed capability token finds nothing', async () => {
    const transfers = new BranchFileDownloadTransfers();
    const transfer = transfers.register(SCOPE, noopSink());

    expect(transfers.claim(transfer.ref, PROOF)).not.toBeNull();
    expect(transfers.claim(transfer.ref, PROOF)).toBeNull();
    transfer.cancel();
    await expect(transfer.delivered).rejects.toThrow();
  });

  it('refuses a claim from another tenant', async () => {
    const transfers = new BranchFileDownloadTransfers();
    const transfer = transfers.register(SCOPE, noopSink());

    expect(transfers.claim(transfer.ref, { ...PROOF, tenantId: 'tenant-b' })).toBeNull();
    // The transfer stays parked for its rightful claimant rather than being consumed.
    expect(transfers.size).toBe(1);
    expect(transfers.claim(transfer.ref, PROOF)).not.toBeNull();
    transfer.cancel();
    await expect(transfer.delivered).rejects.toThrow();
  });

  it('refuses a claim for another branch in the same tenant', async () => {
    const transfers = new BranchFileDownloadTransfers();
    const transfer = transfers.register(SCOPE, noopSink());

    expect(transfers.claim(transfer.ref, { ...PROOF, branchId: 'branch-2' })).toBeNull();
    transfer.cancel();
    await expect(transfer.delivered).rejects.toThrow();
  });

  it('rejects the waiting request when the executor never delivers', async () => {
    vi.useFakeTimers();
    try {
      const transfers = new BranchFileDownloadTransfers(50);
      const transfer = transfers.register(SCOPE, noopSink());
      const settled = expect(transfer.delivered).rejects.toThrow(/expired/i);

      vi.advanceTimersByTime(51);
      await settled;
      // An expired transfer is no longer claimable.
      expect(transfers.claim(transfer.ref, PROOF)).toBeNull();
      expect(transfers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a per-transfer ttl over the registry default', async () => {
    vi.useFakeTimers();
    try {
      const transfers = new BranchFileDownloadTransfers(10_000);
      const transfer = transfers.register(SCOPE, noopSink(), 25);
      const settled = expect(transfer.delivered).rejects.toThrow(/expired/i);
      vi.advanceTimersByTime(26);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel releases the waiter and drops the entry', async () => {
    const transfers = new BranchFileDownloadTransfers();
    const transfer = transfers.register(SCOPE, noopSink());

    transfer.cancel('Client disconnected');
    await expect(transfer.delivered).rejects.toThrow('Client disconnected');
    expect(transfers.size).toBe(0);
    expect(transfers.claim(transfer.ref, PROOF)).toBeNull();
  });

  it('settles exactly once, so a late cancel cannot flip a delivered download', async () => {
    const transfers = new BranchFileDownloadTransfers();
    const transfer = transfers.register(SCOPE, noopSink());

    const claimed = transfers.claim(transfer.ref, PROOF);
    claimed?.settle();
    transfer.cancel('too late');

    await expect(transfer.delivered).resolves.toBeUndefined();
  });

  it('propagates a delivery failure to the waiting request', async () => {
    const transfers = new BranchFileDownloadTransfers();
    const transfer = transfers.register(SCOPE, noopSink());

    transfers.claim(transfer.ref, PROOF)?.settle(new Error('size mismatch'));
    await expect(transfer.delivered).rejects.toThrow('size mismatch');
  });
});
