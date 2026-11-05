/**
 * Send a staged `.agorpack` export to the caller's linked Agor Cloud
 * workspace, then apply it there.
 *
 * The daemon streams the staged file to the workspace's `/agor-pack/uploads`
 * with the linked session (whole-file retry: the workspace stages a pack once
 * per content hash, so a resend returns the same receipt), and proxies apply
 * and receipt reads. Transfer records live in this process: the UI polls the
 * daemon that started the send.
 */

import { Readable, Transform } from 'node:stream';
import { runWithTenantContext } from '@agor/core/db';
import { BadRequest, NotFound } from '@agor/core/feathers';
import { generateId } from '@agor/core/ids';
import {
  AGOR_PACK,
  type AgorCloudTransfer,
  type AgorPackImport,
  agorCloudReconnectUrl,
} from '@agor/core/types';
import { getBlobStagingStore } from '../utils/upload-staging.js';
import { type AgorCloudLinkContext, AgorCloudLinkService } from './agor-cloud-link.js';
import { agorPackBlob } from './agor-pack-export.js';

const UPLOAD_ATTEMPTS = 3;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Finished transfers are kept this long for the UI to read. */
const RETAIN_MS = 24 * 60 * 60 * 1000;

interface TransferRecord extends AgorCloudTransfer {
  tenant_id: string;
  user_id: string;
  updated_at: number;
}

const transfers = new Map<string, TransferRecord>();

function prune(now = Date.now()): void {
  for (const [id, record] of transfers) {
    if (record.status !== 'uploading' && now - record.updated_at > RETAIN_MS) transfers.delete(id);
  }
}

function publicView(record: TransferRecord): AgorCloudTransfer {
  const { tenant_id: _tenant, user_id: _user, updated_at: _updated, ...view } = record;
  return view;
}

class CloudHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function cloudError(response: Response): Promise<CloudHttpError> {
  let message = `Agor Cloud answered ${response.status}`;
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    message = body.error ?? body.message ?? message;
  } catch {
    // keep the status line
  }
  return new CloudHttpError(message, response.status);
}

/** Network failures and 5xx are worth a whole-file resend; 4xx are not. */
const retryable = (error: unknown) =>
  !(error instanceof CloudHttpError) || error.status >= 500 || error.status === 429;

export class AgorCloudTransferService {
  private readonly link: AgorCloudLinkService;

  constructor(private readonly ctx: AgorCloudLinkContext) {
    this.link = new AgorCloudLinkService(ctx);
  }

  /** Fetch a workspace route with the linked session, refreshing once on 401. */
  private async cloudFetch(
    path: string,
    init: (bearer: string) => RequestInit
  ): Promise<{ response: Response; workspaceUrl: string }> {
    let session = await this.link.session();
    let response = await fetch(`${session.workspaceUrl}${path}`, init(session.accessToken));
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      session = await this.link.session(true);
      response = await fetch(`${session.workspaceUrl}${path}`, init(session.accessToken));
    }
    if (!response.ok) throw await cloudError(response);
    return { response, workspaceUrl: session.workspaceUrl };
  }

  private async cloudJson<T>(path: string, body?: unknown): Promise<T> {
    const { response } = await this.cloudFetch(path, (bearer) => ({
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    return (await response.json()) as T;
  }

  private owned(transferId: string): TransferRecord {
    const record = transfers.get(transferId);
    if (
      !record ||
      record.tenant_id !== this.ctx.tenantId ||
      record.user_id !== this.ctx.user.user_id
    ) {
      throw new NotFound('Transfer not found');
    }
    return record;
  }

  /** Start sending one of the caller's staged exports; returns at once. */
  async start(exportId: string, ref: string): Promise<AgorCloudTransfer> {
    prune();
    const blob = agorPackBlob(this.ctx, exportId, ref);
    const store = getBlobStagingStore();
    // Bound to the creator, like the download route.
    const meta = await store.inspect(blob);
    const { workspaceUrl } = await this.link.session();
    const record: TransferRecord = {
      transfer_id: generateId(),
      status: 'uploading',
      bytes_sent: 0,
      bytes_total: meta.size,
      workspace_url: workspaceUrl,
      tenant_id: this.ctx.tenantId,
      user_id: this.ctx.user.user_id,
      updated_at: Date.now(),
    };
    transfers.set(record.transfer_id, record);
    console.log(`[agor-cloud] transfer ${record.transfer_id} started (${meta.size} bytes)`);
    void runWithTenantContext(this.ctx.tenantId, () => this.upload(record, blob)).catch(
      (error: unknown) => {
        record.status = 'failed';
        record.error = error instanceof Error ? error.message : String(error);
        record.updated_at = Date.now();
        console.warn(`[agor-cloud] transfer ${record.transfer_id} failed: ${record.error}`);
      }
    );
    return publicView(record);
  }

  private async upload(record: TransferRecord, blob: ReturnType<typeof agorPackBlob>) {
    const store = getBlobStagingStore();
    let lastError: unknown;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      try {
        const { response } = await this.cloudFetch('/agor-pack/uploads', (bearer) => {
          record.bytes_sent = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              record.bytes_sent += chunk.byteLength;
              record.updated_at = Date.now();
              callback(null, chunk);
            },
          });
          // Opened lazily so a 401 retry reads the file from the start.
          void store.read(blob).then(
            (stream) => {
              stream.once('error', (error) => counter.destroy(error as Error));
              stream.pipe(counter);
            },
            (error: unknown) => counter.destroy(error as Error)
          );
          return {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${bearer}`,
              'Content-Type': AGOR_PACK.mimeType,
              'Content-Length': String(record.bytes_total),
            },
            body: Readable.toWeb(counter) as unknown as RequestInit['body'],
            duplex: 'half',
            redirect: 'error',
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          } as RequestInit;
        });
        record.bytes_sent = record.bytes_total;
        // A resent pack returns the workspace's existing receipt, maybe applied.
        setReceipt(record, (await response.json()) as AgorPackImport);
        console.log(`[agor-cloud] transfer ${record.transfer_id} staged (attempt ${attempt})`);
        return;
      } catch (error) {
        lastError = error;
        if (!retryable(error) || attempt === UPLOAD_ATTEMPTS) break;
        console.warn(
          `[agor-cloud] transfer ${record.transfer_id} attempt ${attempt} failed; retrying`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    throw lastError;
  }

  /** The transfer, with the workspace receipt refreshed while it applies. */
  async get(transferId: string): Promise<AgorCloudTransfer> {
    const record = this.owned(transferId);
    if (record.status === 'applying' && record.import) {
      await this.track(record, () =>
        this.cloudJson<AgorPackImport>(`/agor-pack/imports/${record.import?.import_id}`)
      );
    }
    return publicView(record);
  }

  /** Apply the staged pack in the workspace (new board per teammate). */
  async apply(transferId: string, teammates: string[]): Promise<AgorCloudTransfer> {
    const record = this.owned(transferId);
    if (!record.import || (record.status !== 'staged' && record.status !== 'failed')) {
      throw new BadRequest('This transfer is not ready to import');
    }
    const importId = record.import.import_id;
    await this.track(record, () =>
      this.cloudJson<AgorPackImport>(`/agor-pack/imports/${importId}/apply`, {
        teammates,
        board_id: null,
      })
    );
    return publicView(record);
  }

  private async track(record: TransferRecord, read: () => Promise<AgorPackImport>) {
    setReceipt(record, await read());
  }
}

function setReceipt(record: TransferRecord, receipt: AgorPackImport): void {
  record.import = receipt;
  record.status = receipt.status;
  record.error = receipt.status === 'failed' ? (receipt.error ?? 'Import failed') : undefined;
  if (receipt.status === 'applied') {
    record.open_url = agorCloudReconnectUrl(record.workspace_url, receipt.import_id);
  }
  record.updated_at = Date.now();
}

/** Test seam. */
export function resetAgorCloudTransfersForTests(): void {
  transfers.clear();
}
