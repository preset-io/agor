import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InboundFile } from '@agor/core/gateway';
import { isAllowedDiscordAttachmentUrl } from '@agor/core/gateway';
import type { SessionID, TenantID, UploadRef, UploadStagingStore } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalUploadStagingStore } from '../host/local/upload-staging-store.js';
import {
  buildPromptWithAttachments,
  ingestDiscordInboundImages,
  ingestInboundAttachments,
  isAllowedSlackFileUrl,
  isIngestableFile,
} from './gateway-attachments.js';
import { configureUploadLimits, MAX_UPLOAD_FILE_SIZE } from './upload.js';

function makeFile(overrides: Partial<InboundFile> = {}): InboundFile {
  return {
    id: 'F123',
    name: 'screenshot.png',
    mimetype: 'image/png',
    size: 1024,
    url_private_download: 'https://files.slack.com/files-pri/T1-F123/download/screenshot.png',
    ...overrides,
  };
}

function makeImageResponse(body: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers },
  });
}

const DISCORD_SIGNED_URL =
  'https://cdn.discordapp.com/attachments/333333333333333333/777777777777777777/screenshot.png?ex=66aabbcc&is=66995a11&hm=signature';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const VALID_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCcf/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8BP//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8BP//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cf//Z',
  'base64'
);

function makeDiscordFile(overrides: Partial<InboundFile> = {}): InboundFile {
  return {
    id: '777777777777777777',
    name: 'screenshot.png',
    mimetype: 'image/png',
    size: 1024,
    url_private_download: DISCORD_SIGNED_URL,
    ...overrides,
  };
}

async function listLocalStoreArtifacts(root: string): Promise<string[]> {
  const artifacts: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else {
        artifacts.push(path.relative(root, child).split(path.sep).join('/'));
      }
    }
  }
  await visit(root);
  return artifacts.sort();
}

function expectedLocalStoreArtifacts(refs: readonly string[]): string[] {
  return refs
    .flatMap((ref) => {
      const prefix = path.join('objects', ref.slice(4, 6), ref);
      return [`${prefix}.data`, `${prefix}.json`];
    })
    .map((artifact) => artifact.split(path.sep).join('/'))
    .sort();
}

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function storeWithStage(
  base: LocalUploadStagingStore,
  stage: UploadStagingStore['stage']
): UploadStagingStore {
  return {
    stage,
    inspect: base.inspect.bind(base),
    read: base.read.bind(base),
    consume: base.consume.bind(base),
    delete: base.delete.bind(base),
    cleanupExpired: base.cleanupExpired.bind(base),
  };
}

describe('isAllowedSlackFileUrl', () => {
  it('allows https URLs on slack.com and its subdomains', () => {
    expect(isAllowedSlackFileUrl('https://files.slack.com/files-pri/T1-F1/download/a.png')).toBe(
      true
    );
    expect(isAllowedSlackFileUrl('https://slack.com/some/file')).toBe(true);
  });

  it('rejects other hosts, lookalike domains, plain http, and malformed URLs', () => {
    expect(isAllowedSlackFileUrl('https://evil.example.com/a.png')).toBe(false);
    expect(isAllowedSlackFileUrl('https://notslack.com/a.png')).toBe(false);
    expect(isAllowedSlackFileUrl('https://files.slack.com.evil.com/a.png')).toBe(false);
    expect(isAllowedSlackFileUrl('http://files.slack.com/a.png')).toBe(false);
    expect(isAllowedSlackFileUrl('not a url')).toBe(false);
  });
});

describe('isIngestableFile', () => {
  it('accepts allowlisted image types and normalizes mime parameters', () => {
    expect(isIngestableFile(makeFile({ mimetype: 'image/png' }))).toBe(true);
    expect(isIngestableFile(makeFile({ mimetype: 'IMAGE/JPEG; charset=binary' }))).toBe(true);
  });

  it('accepts allowlisted text-like types', () => {
    expect(isIngestableFile(makeFile({ mimetype: 'text/plain' }))).toBe(true);
    expect(isIngestableFile(makeFile({ mimetype: 'text/csv' }))).toBe(true);
    expect(isIngestableFile(makeFile({ mimetype: 'text/markdown' }))).toBe(true);
    expect(isIngestableFile(makeFile({ mimetype: 'application/json' }))).toBe(true);
    expect(isIngestableFile(makeFile({ mimetype: 'Text/Plain; charset=utf-8' }))).toBe(true);
  });

  it('rejects non-allowlisted types', () => {
    expect(isIngestableFile(makeFile({ mimetype: 'image/svg+xml' }))).toBe(false);
    expect(isIngestableFile(makeFile({ mimetype: 'text/html' }))).toBe(false);
    expect(isIngestableFile(makeFile({ mimetype: 'application/x-sh' }))).toBe(false);
    expect(isIngestableFile(makeFile({ mimetype: 'application/xml' }))).toBe(false);
  });

  it('rejects allowlisted types outside the image/text ingest scope', () => {
    expect(isIngestableFile(makeFile({ mimetype: 'application/pdf' }))).toBe(false);
    expect(isIngestableFile(makeFile({ mimetype: 'application/zip' }))).toBe(false);
  });
});

describe('buildPromptWithAttachments', () => {
  const uploadRef = 'upl_00000000-0000-4000-8000-000000000001';
  const attachment = {
    ref: uploadRef as UploadRef,
    name: 'error.log',
    mimeType: 'text/plain',
    size: 1024,
    provenance: 'slack' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
  };

  it('returns the trimmed text when there are no attachments', () => {
    expect(buildPromptWithAttachments('  hello  ', [])).toBe('hello');
  });

  it('prepends useful attachment metadata to regular prompts', () => {
    expect(buildPromptWithAttachments('look at this', [attachment])).toBe(
      `Attachments — use \`agor_upload_materialize\` to access:\n- [error.log](https://agor.live/_uploads/${uploadRef}) (text/plain, 1.0 KiB)\n\nlook at this`
    );
  });

  it('keeps slash commands first', () => {
    expect(buildPromptWithAttachments('/review', [attachment])).toBe(
      `/review\n\nAttachments — use \`agor_upload_materialize\` to access:\n- [error.log](https://agor.live/_uploads/${uploadRef}) (text/plain, 1.0 KiB)`
    );
  });

  it('returns only the attachment block when the text is empty', () => {
    expect(buildPromptWithAttachments('', [attachment])).toBe(
      `Attachments — use \`agor_upload_materialize\` to access:\n- [error.log](https://agor.live/_uploads/${uploadRef}) (text/plain, 1.0 KiB)`
    );
  });
});

describe('ingestInboundAttachments', () => {
  let uploadDir: string;
  let store: LocalUploadStagingStore;
  const tenantId = 'tenant-test' as TenantID;
  const sessionId = '00000000-0000-0000-0000-000000000001' as SessionID;

  beforeEach(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-attachments-'));
    store = new LocalUploadStagingStore(() => uploadDir);
  });

  async function readStaged(ref: string): Promise<Buffer> {
    const stream = await store.read({
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      ref: ref as never,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }

  afterEach(async () => {
    await fs.rm(uploadDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('downloads an image with the bot token and stores it in the upload dir', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi.fn(async () => makeImageResponse(bytes));

    const result = await ingestInboundAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://files.slack.com/files-pri/T1-F123/download/screenshot.png',
      { headers: { Authorization: 'Bearer xoxb-test' }, redirect: 'manual' }
    );
    expect(result.failed).toBe(0);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0].ref).toMatch(/^upl_/);
    expect(result.uploads[0].name).toBe('F123_screenshot.png');
    expect(new Uint8Array(await readStaged(result.uploads[0].ref))).toEqual(bytes);
  });

  it('downloads a text attachment and stores it in the upload dir', async () => {
    const body = 'ts,level,message\n1,error,boom\n';
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8' },
        })
    );

    const result = await ingestInboundAttachments({
      files: [
        makeFile({
          name: 'errors.csv',
          mimetype: 'text/csv',
          url_private_download: 'https://files.slack.com/files-pri/T1-F123/download/errors.csv',
        }),
      ],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result.failed).toBe(0);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0].name).toBe('F123_errors.csv');
    expect((await readStaged(result.uploads[0].ref)).toString('utf8')).toBe(body);
  });

  it('ignores non-ingestable attachments without counting them as failures', async () => {
    const fetchImpl = vi.fn();

    const result = await ingestInboundAttachments({
      files: [makeFile({ mimetype: 'application/pdf', name: 'doc.pdf' })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ uploads: [], failed: 0 });
  });

  it('never fetches disallowed hosts and counts them as failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn();

    const result = await ingestInboundAttachments({
      files: [makeFile({ url_private_download: 'https://evil.example.com/a.png' })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ uploads: [], failed: 1 });
    expect(warn).toHaveBeenCalled();
  });

  it('skips files whose declared size exceeds the per-file limit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn();

    const result = await ingestInboundAttachments({
      files: [makeFile({ size: MAX_UPLOAD_FILE_SIZE + 1 })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ uploads: [], failed: 1 });
  });

  it('rejects redirects to non-allowlisted hosts and never sends the token there', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/exfil.png' },
        })
    );

    const result = await ingestInboundAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result).toEqual({ uploads: [], failed: 1 });
    // The Authorization header must only ever reach allowlisted slack.com
    // hosts: the redirect target is validated BEFORE any fetch to it.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const [calledUrl] of fetchImpl.mock.calls) {
      expect(isAllowedSlackFileUrl(calledUrl as string)).toBe(true);
    }
  });

  it('follows redirects between allowlisted Slack hosts with the token', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://files.slack.com/files-pri/T1-F123/other/screenshot.png' },
        })
      )
      .mockResolvedValueOnce(makeImageResponse(bytes));

    const result = await ingestInboundAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result.failed).toBe(0);
    expect(result.uploads).toHaveLength(1);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://files.slack.com/files-pri/T1-F123/other/screenshot.png',
      { headers: { Authorization: 'Bearer xoxb-test' }, redirect: 'manual' }
    );
  });

  it('aborts oversized streaming bodies without a trustworthy Content-Length', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chunkSize = 1024 * 1024;
    let chunksPulled = 0;
    // Endless text stream with no Content-Length: if the implementation
    // buffered before checking, this test would never terminate.
    const endlessBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled++;
        controller.enqueue(new Uint8Array(chunkSize));
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(endlessBody, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
    );

    const result = await ingestInboundAttachments({
      files: [makeFile({ name: 'server.log', mimetype: 'text/plain' })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result).toEqual({ uploads: [], failed: 1 });
    // Reading stopped as soon as the running total crossed the 50MB ceiling.
    expect(chunksPulled).toBeLessThanOrEqual(MAX_UPLOAD_FILE_SIZE / chunkSize + 3);
    const objectBuckets = await fs.readdir(path.join(uploadDir, 'objects'));
    for (const bucket of objectBuckets) {
      expect(await fs.readdir(path.join(uploadDir, 'objects', bucket))).toEqual([]);
    }
  });

  it('rejects image/svg+xml response bodies (excluded from the upload allowlist)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      async () =>
        new Response('<svg onload="alert(1)"/>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        })
    );

    const result = await ingestInboundAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result).toEqual({ uploads: [], failed: 1 });
    expect(await fs.readdir(uploadDir)).toEqual([]);
  });

  it('rejects response bodies whose type is allowlisted but outside the ingest scope', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      async () =>
        new Response('%PDF-1.4', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        })
    );

    const result = await ingestInboundAttachments({
      files: [makeFile({ name: 'report.txt', mimetype: 'text/plain' })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result).toEqual({ uploads: [], failed: 1 });
    expect(await fs.readdir(uploadDir)).toEqual([]);
  });

  it('stores same-named files with distinct Slack IDs at distinct paths', async () => {
    const fetchImpl = vi.fn(async () => makeImageResponse(new Uint8Array([1])));

    const result = await ingestInboundAttachments({
      files: [makeFile({ id: 'F1', name: 'image.png' }), makeFile({ id: 'F2', name: 'image.png' })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result.failed).toBe(0);
    expect(result.uploads).toHaveLength(2);
    expect(result.uploads[0].ref).not.toBe(result.uploads[1].ref);
    expect(await readStaged(result.uploads[0].ref)).toEqual(Buffer.from([1]));
    expect(await readStaged(result.uploads[1].ref)).toEqual(Buffer.from([1]));
    expect(result.uploads.map((upload) => upload.name)).toEqual(['F1_image.png', 'F2_image.png']);
  });

  it('rejects non-image response bodies (Slack HTML error pages)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html>login</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
    );

    const result = await ingestInboundAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result).toEqual({ uploads: [], failed: 1 });
  });

  it('continues past failures and still stores the remaining images', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(makeImageResponse(bytes));

    const result = await ingestInboundAttachments({
      files: [
        makeFile({ id: 'F1', name: 'first.png' }),
        makeFile({ id: 'F2', name: 'second.png' }),
      ],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(result.failed).toBe(1);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0].name).toBe('F2_second.png');
  });

  it('counts images beyond the per-message cap as failed without fetching them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bytes = new Uint8Array([1]);
    const fetchImpl = vi.fn(async () => makeImageResponse(bytes));
    const files = Array.from({ length: 12 }, (_, i) =>
      makeFile({ id: `F${i}`, name: `img-${i}.png` })
    );

    const result = await ingestInboundAttachments({
      files,
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId: '00000000-0000-0000-0000-000000000003' as never,
      createdBy: '00000000-0000-0000-0000-000000000004' as never,
      store,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(result.uploads).toHaveLength(10);
    expect(result.failed).toBe(2);
  });
});

describe('ingestDiscordInboundImages', () => {
  let uploadDir: string;
  let store: LocalUploadStagingStore;
  const tenantId = 'tenant-discord' as TenantID;
  const sessionId = '00000000-0000-0000-0000-000000000011' as SessionID;
  const branchId = '00000000-0000-0000-0000-000000000013' as never;
  const createdBy = '00000000-0000-0000-0000-000000000014' as never;

  beforeEach(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-discord-attachments-'));
    store = new LocalUploadStagingStore(() => uploadDir);
  });

  afterEach(async () => {
    await fs.rm(uploadDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('allows only signed Discord CDN attachment URLs', () => {
    expect(isAllowedDiscordAttachmentUrl(DISCORD_SIGNED_URL)).toBe(true);
    expect(
      isAllowedDiscordAttachmentUrl(
        DISCORD_SIGNED_URL.replace('cdn.discordapp.com', 'evil.example')
      )
    ).toBe(false);
    expect(isAllowedDiscordAttachmentUrl(DISCORD_SIGNED_URL.replace('?ex=', '?missing='))).toBe(
      false
    );
    expect(isAllowedDiscordAttachmentUrl(DISCORD_SIGNED_URL.replace('https://', 'http://'))).toBe(
      false
    );
  });

  it('downloads a PNG without credentials and stages it under the exact owner', async () => {
    const bytes = VALID_PNG;
    const fetchImpl = vi.fn(async () => makeImageResponse(bytes));

    const result = await ingestDiscordInboundImages({
      files: [makeDiscordFile()],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      DISCORD_SIGNED_URL,
      expect.objectContaining({ headers: {}, redirect: 'manual' })
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(result.failed).toBe(0);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]).toMatchObject({
      name: '777777777777777777_screenshot.png',
      mimeType: 'image/png',
      provenance: 'gateway-discord',
    });
    const stored = await store.inspect({
      tenantId,
      sessionId,
      branchId,
      ref: result.uploads[0].ref,
    });
    expect(stored).toMatchObject({ provenance: 'gateway-discord', size: bytes.byteLength });
    await expect(
      store.inspect({
        tenantId: 'other-tenant' as TenantID,
        sessionId,
        branchId,
        ref: result.uploads[0].ref,
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['PNG', VALID_PNG, 'image/png', 'screenshot.png'],
    ['JPEG', VALID_JPEG, 'image/jpeg', 'screenshot.jpg'],
  ] as const)('stages a valid %s fixture', async (_label, bytes, mimeType, name) => {
    const fetchImpl = vi.fn(async () => makeImageResponse(bytes, { 'content-type': mimeType }));

    const result = await ingestDiscordInboundImages({
      files: [makeDiscordFile({ mimetype: mimeType, name })],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store,
    });

    expect(result.failed).toBe(0);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]).toMatchObject({ mimeType, size: bytes.byteLength });
  });

  it('rejects empty image downloads, cleans them, and continues with a valid image', async () => {
    const emptyBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(emptyBody, { status: 200, headers: { 'content-type': 'image/jpeg' } })
      )
      .mockResolvedValueOnce(makeImageResponse(VALID_PNG));

    const result = await ingestDiscordInboundImages({
      files: [
        makeDiscordFile({ name: 'empty.jpg', mimetype: 'image/jpeg' }),
        makeDiscordFile({ id: '888888888888888888', name: 'second.png' }),
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store,
    });

    expect(result.failed).toBe(1);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]).toMatchObject({
      name: '888888888888888888_second.png',
      mimeType: 'image/png',
      size: VALID_PNG.byteLength,
    });
    const artifacts = await listLocalStoreArtifacts(uploadDir);
    expect(artifacts.filter((artifact) => artifact.endsWith('.partial'))).toEqual([]);
    expect(artifacts).toEqual(
      expectedLocalStoreArtifacts(result.uploads.map((upload) => upload.ref))
    );
    const dataArtifacts = artifacts.filter((artifact) => artifact.endsWith('.data'));
    expect(dataArtifacts).toHaveLength(1);
    expect(await fs.stat(path.join(uploadDir, dataArtifacts[0]!))).toMatchObject({
      size: VALID_PNG.byteLength,
    });
  });

  it('joins deferred failed staging cleanup before continuing to the next attachment', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: string[] = [];
    const stageStarted = makeDeferred<void>();
    const cleanupStarted = makeDeferred<void>();
    const cleanupFinished = makeDeferred<void>();
    let firstBodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stageCalls = 0;
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        firstBodyController = controller;
        controller.enqueue(VALID_PNG.subarray(0, 4));
      },
    });
    const controlledStore = storeWithStage(store, async (input) => {
      stageCalls++;
      if (stageCalls > 1) {
        events.push('second-stage-started');
        return store.stage(input);
      }

      events.push('stage-started');
      stageStarted.resolve();
      let cleanupObserved = false;
      const observeCleanup = () => {
        if (cleanupObserved) return;
        cleanupObserved = true;
        events.push('cleanup-started');
        cleanupStarted.resolve();
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          events.push('cleanup-finished');
          cleanupFinished.resolve();
        };
        channel.port2.postMessage(undefined);
      };
      input.body.once('error', observeCleanup);
      input.body.once('close', observeCleanup);
      await cleanupFinished.promise;
      events.push('stage-settled');
      throw new Error('controlled staging failure');
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(firstBody, { status: 200, headers: { 'content-type': 'image/png' } })
      )
      .mockImplementationOnce(async () => {
        events.push('second-fetch-started');
        await cleanupFinished.promise;
        return makeImageResponse(VALID_PNG);
      });

    const resultPromise = ingestDiscordInboundImages({
      files: [
        makeDiscordFile({ name: 'first.png' }),
        makeDiscordFile({ id: '888888888888888888', name: 'second.png' }),
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store: controlledStore,
    });

    await stageStarted.promise;
    expect(firstBodyController).toBeDefined();
    firstBodyController!.error(new Error('controlled CDN reset'));
    await cleanupStarted.promise;

    const result = await resultPromise;

    expect(result.failed).toBe(1);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]).toMatchObject({
      name: '888888888888888888_second.png',
      size: VALID_PNG.byteLength,
    });
    expect(events.indexOf('stage-settled')).toBeLessThan(events.indexOf('second-fetch-started'));
    expect(events.indexOf('cleanup-finished')).toBeLessThan(events.indexOf('second-fetch-started'));
  });

  it('tears down an open source when staging fails first and continues', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let stageCalls = 0;
    let sourceCancelled = false;
    const openBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const controlledStore = storeWithStage(store, async (input) => {
      stageCalls++;
      if (stageCalls === 1) throw new Error('controlled stage-first failure');
      return store.stage(input);
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(openBody, { status: 200, headers: { 'content-type': 'image/png' } })
      )
      .mockResolvedValueOnce(makeImageResponse(VALID_PNG));

    const result = await ingestDiscordInboundImages({
      files: [
        makeDiscordFile({ name: 'first.png' }),
        makeDiscordFile({ id: '888888888888888888', name: 'second.png' }),
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store: controlledStore,
    });

    expect(result.failed).toBe(1);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]).toMatchObject({
      name: '888888888888888888_second.png',
      size: VALID_PNG.byteLength,
    });
    expect(stageCalls).toBe(2);
    expect(sourceCancelled).toBe(true);
  });

  it('fails closed for unsafe URLs, expired responses, and non-image bodies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })
      );
    const result = await ingestDiscordInboundImages({
      files: [
        makeDiscordFile({ url_private_download: 'https://attacker.example/image.png' }),
        makeDiscordFile({ id: '888888888888888888', url_private_download: DISCORD_SIGNED_URL }),
        makeDiscordFile({ id: '999999999999999999', url_private_download: DISCORD_SIGNED_URL }),
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store,
    });

    expect(result).toEqual({ uploads: [], failed: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(DISCORD_SIGNED_URL);
  });

  it('enforces the declared per-file and existing per-message count limits', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => makeImageResponse(new Uint8Array([1])));
    const files = [
      makeDiscordFile({ size: MAX_UPLOAD_FILE_SIZE + 1 }),
      ...Array.from({ length: 11 }, (_, index) =>
        makeDiscordFile({
          id: `${String(700000000000000000 + index).padStart(18, '0')}`,
          name: `image-${index}.png`,
        })
      ),
    ];

    const result = await ingestDiscordInboundImages({
      files,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(result.uploads).toHaveLength(9);
    expect(result.failed).toBe(3);
  });

  it('does not send credentials while rejecting a redirect to an unsafe host', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/exfil.png' },
        })
    );

    const result = await ingestDiscordInboundImages({
      files: [makeDiscordFile()],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store,
    });

    expect(result).toEqual({ uploads: [], failed: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(DISCORD_SIGNED_URL);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: {},
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
  });

  it('propagates a mid-body failure, cleans partial bytes, and continues', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(VALID_PNG.subarray(0, 4));
        setTimeout(() => controller.error(new Error('simulated CDN connection reset')), 0);
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(failingBody, { status: 200, headers: { 'content-type': 'image/png' } })
      )
      .mockResolvedValueOnce(makeImageResponse(VALID_PNG));

    const result = await ingestDiscordInboundImages({
      files: [
        makeDiscordFile({ id: '777777777777777777', name: 'first.png' }),
        makeDiscordFile({ id: '888888888888888888', name: 'second.png' }),
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tenantId,
      sessionId,
      branchId,
      createdBy,
      store,
    });

    expect(result.failed).toBe(1);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0].name).toBe('888888888888888888_second.png');
    const artifacts = await listLocalStoreArtifacts(uploadDir);
    expect(artifacts.filter((artifact) => artifact.endsWith('.partial'))).toEqual([]);
    expect(artifacts).toEqual(
      expectedLocalStoreArtifacts(result.uploads.map((upload) => upload.ref))
    );
  });

  it('times out stalled headers and continues with the next attachment', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockReturnValueOnce(new Promise<Response>(() => undefined))
        .mockResolvedValueOnce(makeImageResponse(VALID_PNG));
      const resultPromise = ingestDiscordInboundImages({
        files: [
          makeDiscordFile({ id: '777777777777777777', name: 'stalled.png' }),
          makeDiscordFile({ id: '888888888888888888', name: 'next.png' }),
        ],
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tenantId,
        sessionId,
        branchId,
        createdBy,
        store,
        downloadTimeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      const result = await resultPromise;
      expect(result.failed).toBe(1);
      expect(result.uploads).toHaveLength(1);
      expect(result.uploads[0].name).toBe('888888888888888888_next.png');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
      const firstRequest = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(firstRequest?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a trickling body, cleans partial bytes, and continues', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const tricklingBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(tricklingBody, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          })
        )
        .mockResolvedValueOnce(makeImageResponse(VALID_PNG));
      const resultPromise = ingestDiscordInboundImages({
        files: [
          makeDiscordFile({ id: '777777777777777777', name: 'trickling.png' }),
          makeDiscordFile({ id: '888888888888888888', name: 'next.png' }),
        ],
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tenantId,
        sessionId,
        branchId,
        createdBy,
        store,
        downloadTimeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      const result = await resultPromise;
      expect(result.failed).toBe(1);
      expect(result.uploads).toHaveLength(1);
      expect(result.uploads[0].name).toBe('888888888888888888_next.png');
      expect(cancelled).toBe(true);
      const artifacts = await listLocalStoreArtifacts(uploadDir);
      expect(artifacts.filter((artifact) => artifact.endsWith('.partial'))).toEqual([]);
      expect(artifacts).toEqual(
        expectedLocalStoreArtifacts(result.uploads.map((upload) => upload.ref))
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds actual aggregate bytes even when Discord underreports the attachment size', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureUploadLimits(4);
    let chunksPulled = 0;
    const endlessBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled++;
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(endlessBody, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
    );

    try {
      const result = await ingestDiscordInboundImages({
        files: [makeDiscordFile({ size: 1 })],
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tenantId,
        sessionId,
        branchId,
        createdBy,
        store,
      });

      expect(result).toEqual({ uploads: [], failed: 1 });
      // A stream may already have one high-water-mark of data queued, but it
      // must stop near the bounded aggregate ceiling rather than buffering
      // the untrusted response indefinitely.
      expect(chunksPulled).toBeLessThan(100_000);
    } finally {
      configureUploadLimits(MAX_UPLOAD_FILE_SIZE);
    }
  });
});
