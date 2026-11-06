/**
 * Move teammates to the caller's linked Agor Cloud workspace (Settings →
 * Agor Cloud → Move to Agor Cloud). The daemon runs the whole move, so the
 * browser can close: one teammate after another, it exports a `.agor` (staged
 * here), sends it to the workspace with the resumable chunked upload, and
 * imports it there on a new board, following the workspace's receipt until it
 * is applied. One teammate failing doesn't stop the rest. Retry resends the
 * same staged file: the upload resumes, and the workspace stages a file once
 * per content hash and resumes its import, so nothing is imported twice.
 *
 * A move is bound to the sign-in it started with (its generation, workspace,
 * and Cloud user): if the user disconnects or signs in again, every later
 * request of that move stops instead of following the new link. Moves live in
 * this process: the UI polls the daemon that started one.
 */

import type { Readable } from 'node:stream';
import { uploadPackChunked } from '@agor/core/agor-pack/upload-client';
import { Conflict, NotFound } from '@agor/core/feathers';
import { generateId } from '@agor/core/ids';
import {
  type AgorCloudMove,
  type AgorCloudMoveItem,
  type AgorPackExportOptions,
  type AgorPackImport,
  agorCloudFinishSetupUrl,
  getTeammateConfig,
} from '@agor/core/types';
import { deferWithTenantContext } from '../utils/tenant-db-scope.js';
import { getBlobStagingStore } from '../utils/upload-staging.js';
import { AGOR_CLOUD_LINK_CHANGED, AgorCloudLinkService } from './agor-cloud-link.js';
import {
  AgorPackExporter,
  type AgorPackServiceContext,
  type AgorPackStagedExport,
  agorPackBlob,
} from './agor-pack-export.js';

const REQUEST_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const APPLY_POLL_MS = 2_000;
/** Finished moves are kept this long for the UI to read. */
const RETAIN_MS = 24 * 60 * 60 * 1000;

interface ItemRecord extends AgorCloudMoveItem {
  /** The staged `.agor` of this teammate, kept so Retry resends the same file. */
  export?: Pick<AgorPackStagedExport, 'export_id' | 'ref' | 'size' | 'sha256'>;
}

interface MoveRecord extends Omit<AgorCloudMove, 'items'> {
  items: ItemRecord[];
  tenant_id: string;
  user_id: string;
  updated_at: number;
  running: boolean;
  /** The sign-in this move was started with. */
  link_generation: string;
  cloud_user_id: string | null;
  /** Export options for every teammate (session history, left-out sessions). */
  options: Omit<AgorPackExportOptions, 'branch_ids'>;
}

const moves = new Map<string, MoveRecord>();
/**
 * One running move per user: `${tenant}:${user}` → move id ('' while a start
 * is still checking). Taken synchronously before any await by start and
 * retry, released when the move's run ends.
 */
const active = new Map<string, string>();

function prune(now = Date.now()): void {
  for (const [id, record] of moves) {
    if (!record.running && now - record.updated_at > RETAIN_MS) moves.delete(id);
  }
}

function publicView(record: MoveRecord): AgorCloudMove {
  return {
    move_id: record.move_id,
    status: record.status,
    workspace_url: record.workspace_url,
    workspace_display_name: record.workspace_display_name,
    created_at: record.created_at,
    items: record.items.map(({ export: _export, ...item }) => item),
  };
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

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class AgorCloudMoveService {
  private readonly link: AgorCloudLinkService;

  constructor(private readonly ctx: AgorPackServiceContext) {
    this.link = new AgorCloudLinkService(ctx);
  }

  /**
   * The linked session, only while it is the sign-in this move started with
   * (same generation, workspace, and Cloud user).
   */
  private async session(record: MoveRecord, force = false) {
    const session = await this.link.session({ force, generation: record.link_generation });
    if (
      session.workspaceUrl !== record.workspace_url ||
      session.cloudUserId !== record.cloud_user_id
    ) {
      throw new Conflict(AGOR_CLOUD_LINK_CHANGED);
    }
    return session;
  }

  /** Fetch a route of the move's workspace, refreshing the session once on 401. */
  private async cloudFetch(
    record: MoveRecord,
    path: string,
    init: (bearer: string) => RequestInit
  ): Promise<Response> {
    const url = `${record.workspace_url}${path}`;
    let response = await fetch(url, init((await this.session(record)).accessToken));
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      response = await fetch(url, init((await this.session(record, true)).accessToken));
    }
    return response;
  }

  private async cloudJson<T>(record: MoveRecord, path: string, body?: unknown): Promise<T> {
    const response = await this.cloudFetch(record, path, (bearer) => ({
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
    if (!response.ok) throw await cloudError(response);
    return (await response.json()) as T;
  }

  private owned(moveId: string): MoveRecord {
    const record = moves.get(moveId);
    if (
      !record ||
      record.tenant_id !== this.ctx.tenantId ||
      record.user_id !== this.ctx.user.user_id
    ) {
      throw new NotFound('Move not found');
    }
    return record;
  }

  private get activeKey(): string {
    return `${this.ctx.tenantId}:${this.ctx.user.user_id}`;
  }

  /**
   * The caller's latest move for the current sign-in (running, or finished in
   * the last day), if any. Moves of an earlier sign-in can't be retried, so
   * they aren't offered.
   */
  async latest(): Promise<AgorCloudMove | null> {
    prune();
    const generation = await this.link.generation();
    if (!generation) return null;
    let latest: MoveRecord | null = null;
    for (const record of moves.values()) {
      if (
        record.tenant_id !== this.ctx.tenantId ||
        record.user_id !== this.ctx.user.user_id ||
        record.link_generation !== generation
      ) {
        continue;
      }
      if (!latest || record.created_at > latest.created_at) latest = record;
    }
    return latest ? publicView(latest) : null;
  }

  get(moveId: string): AgorCloudMove {
    return publicView(this.owned(moveId));
  }

  /**
   * Check every teammate (owner or admin, full access) and the sign-in, then
   * move them in the background; returns at once.
   */
  async start(request: AgorPackExportOptions): Promise<AgorCloudMove> {
    prune();
    this.reserve('');
    let teammates: Awaited<ReturnType<AgorPackExporter['authorize']>>;
    let session: Awaited<ReturnType<AgorCloudLinkService['session']>>;
    let link: Awaited<ReturnType<AgorCloudLinkService['status']>>['link'];
    try {
      teammates = await new AgorPackExporter(this.ctx).authorize(request.branch_ids);
      session = await this.link.session();
      link = (await this.link.status()).link;
    } catch (error) {
      active.delete(this.activeKey);
      throw error;
    }
    const { branch_ids: _branchIds, ...options } = request;
    const record: MoveRecord = {
      move_id: generateId(),
      status: 'moving',
      workspace_url: session.workspaceUrl,
      workspace_display_name: link?.workspace_display_name ?? null,
      created_at: new Date().toISOString(),
      items: teammates.map(({ branch }) => {
        const teammate = getTeammateConfig(branch);
        return {
          branch_id: branch.branch_id,
          display_name: teammate?.displayName ?? branch.name,
          emoji: teammate?.emoji ?? null,
          status: 'waiting',
          bytes_sent: 0,
          bytes_total: 0,
        };
      }),
      tenant_id: this.ctx.tenantId,
      user_id: this.ctx.user.user_id,
      updated_at: Date.now(),
      running: false,
      link_generation: session.generation,
      cloud_user_id: session.cloudUserId,
      options,
    };
    moves.set(record.move_id, record);
    active.set(this.activeKey, record.move_id);
    console.log(`[agor-cloud] move ${record.move_id} started (${record.items.length} teammates)`);
    this.launch(record);
    return publicView(record);
  }

  /** Move a failed teammate again; the rest of the move is left as it is. */
  retry(moveId: string, branchId: string): AgorCloudMove {
    const record = this.owned(moveId);
    const item = record.items.find((candidate) => candidate.branch_id === branchId);
    if (!item) throw new NotFound('Teammate not in this move');
    if (item.status === 'failed') {
      if (!record.running) this.reserve(record.move_id);
      item.status = 'waiting';
      item.error = undefined;
      record.updated_at = Date.now();
      this.launch(record);
    }
    return publicView(record);
  }

  /** Take the caller's one-move slot (synchronously) or refuse. */
  private reserve(moveId: string): void {
    if (active.has(this.activeKey)) {
      throw new Conflict('A move is already running. Wait until it finishes.');
    }
    active.set(this.activeKey, moveId);
  }

  private launch(record: MoveRecord): void {
    record.status = 'moving';
    if (record.running) return;
    record.running = true;
    deferWithTenantContext(
      { tenant: { tenant_id: record.tenant_id } },
      () => this.run(record),
      (error) => console.error(`[agor-cloud] move ${record.move_id} stopped`, error)
    );
  }

  private async run(record: MoveRecord): Promise<void> {
    try {
      for (;;) {
        // Re-read each turn: Retry can queue a teammate while this runs.
        const item = record.items.find((candidate) => candidate.status === 'waiting');
        if (!item) break;
        try {
          await this.moveItem(record, item);
        } catch (error) {
          item.status = 'failed';
          item.error = errorMessage(error);
          console.warn(
            `[agor-cloud] move ${record.move_id}: ${item.branch_id} failed: ${item.error}`
          );
        }
        record.updated_at = Date.now();
      }
    } finally {
      record.running = false;
      record.status = 'finished';
      record.updated_at = Date.now();
      const key = `${record.tenant_id}:${record.user_id}`;
      if (active.get(key) === record.move_id) active.delete(key);
    }
  }

  private async moveItem(record: MoveRecord, item: ItemRecord): Promise<void> {
    const store = getBlobStagingStore();
    const touch = () => {
      record.updated_at = Date.now();
    };
    // The file already reached the workspace: follow its receipt. Only a
    // receipt the workspace says doesn't exist (404) sends the file again;
    // any other error fails this try, so a changed teammate is never imported twice.
    if (item.import_id) {
      const known = await this.receipt(record, item.import_id);
      if (known) {
        item.status = 'importing';
        touch();
        await this.finishImport(record, item, known);
        return;
      }
      item.import_id = undefined;
    }
    // Rebuild the file when it was never built or its staging has expired.
    const staged =
      item.export &&
      (await store
        .inspect(agorPackBlob(this.ctx, item.export.export_id, item.export.ref))
        .then(() => true)
        .catch(() => false));
    if (!staged) {
      item.status = 'exporting';
      touch();
      const exporter = new AgorPackExporter(this.ctx);
      const teammates = await exporter.authorize([item.branch_id]);
      const result = await exporter.stage(
        { ...record.options, branch_ids: [item.branch_id] },
        teammates
      );
      item.export = {
        export_id: result.export_id,
        ref: result.ref,
        size: result.size,
        sha256: result.sha256,
      };
    }
    const file = item.export as NonNullable<ItemRecord['export']>;
    const blob = agorPackBlob(this.ctx, file.export_id, file.ref);
    item.status = 'sending';
    item.bytes_sent = 0;
    item.bytes_total = file.size;
    touch();

    // Our own refusals (a changed or expired sign-in) stop the upload at once
    // instead of being retried as network errors.
    const refused = new AbortController();
    const receipt = await uploadPackChunked({
      size: file.size,
      sha256: file.sha256,
      readChunk: async (start, end) =>
        readAll((await store.read({ ...blob, offset: start, length: end - start })) as Readable),
      send: async (path, init) => {
        try {
          return await this.cloudFetch(record, path, (bearer) => ({
            method: init.method,
            headers: { ...(init.headers ?? {}), Authorization: `Bearer ${bearer}` },
            body: init.body as RequestInit['body'],
            redirect: 'error',
            signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
          }));
        } catch (error) {
          if (typeof (error as { code?: unknown })?.code === 'number') refused.abort(error);
          throw error;
        }
      },
      onProgress: (sent) => {
        item.bytes_sent = sent;
        touch();
      },
      signal: refused.signal,
    });
    item.bytes_sent = file.size;
    item.import_id = receipt.import_id;
    item.status = 'importing';
    touch();
    await this.finishImport(record, item, receipt);
  }

  /** The workspace's receipt for an import, or null when it has none (404). */
  private async receipt(record: MoveRecord, importId: string): Promise<AgorPackImport | null> {
    const response = await this.cloudFetch(record, `/agor-pack/imports/${importId}`, (bearer) => ({
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    if (response.status === 404) return null;
    if (!response.ok) throw await cloudError(response);
    return (await response.json()) as AgorPackImport;
  }

  /** Apply (or resume) the import in the workspace and follow it until it settles. */
  private async finishImport(
    record: MoveRecord,
    item: ItemRecord,
    staged: AgorPackImport
  ): Promise<void> {
    let receipt = staged;
    // A file the workspace already has returns its receipt, maybe applied.
    const importPath = `/agor-pack/imports/${receipt.import_id}`;
    if (receipt.status !== 'applied' && receipt.status !== 'applying') {
      receipt = await this.cloudJson<AgorPackImport>(record, `${importPath}/apply`, {
        teammates: receipt.manifest.teammates.map((teammate) => teammate.key),
        board_id: null,
      });
    }
    while (receipt.status === 'applying') {
      await new Promise((resolve) => setTimeout(resolve, APPLY_POLL_MS));
      receipt = await this.cloudJson<AgorPackImport>(record, importPath);
    }
    if (receipt.status !== 'applied') {
      throw new Error(receipt.error ?? 'The import in Agor Cloud stopped');
    }
    item.status = 'done';
    record.updated_at = Date.now();
    item.open_url = agorCloudFinishSetupUrl(
      this.link.settings.consoleUrl,
      record.workspace_url,
      receipt.import_id
    );
    console.log(`[agor-cloud] move ${record.move_id}: ${item.branch_id} done`);
  }
}

/** Test seam. */
export function resetAgorCloudMovesForTests(): void {
  moves.clear();
  active.clear();
}
