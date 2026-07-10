import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InboundFile } from '@agor/core/gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPromptWithAttachments,
  ingestInboundImageAttachments,
  isAllowedSlackFileUrl,
  isIngestableImageFile,
} from './gateway-attachments.js';
import { MAX_UPLOAD_FILE_SIZE } from './upload.js';

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

describe('isIngestableImageFile', () => {
  it('accepts allowlisted image types and normalizes mime parameters', () => {
    expect(isIngestableImageFile(makeFile({ mimetype: 'image/png' }))).toBe(true);
    expect(isIngestableImageFile(makeFile({ mimetype: 'IMAGE/JPEG; charset=binary' }))).toBe(true);
  });

  it('rejects non-image and non-allowlisted types', () => {
    expect(isIngestableImageFile(makeFile({ mimetype: 'application/pdf' }))).toBe(false);
    expect(isIngestableImageFile(makeFile({ mimetype: 'image/svg+xml' }))).toBe(false);
    expect(isIngestableImageFile(makeFile({ mimetype: 'text/html' }))).toBe(false);
  });
});

describe('buildPromptWithAttachments', () => {
  it('returns the trimmed text when there are no attachments', () => {
    expect(buildPromptWithAttachments('  hello  ', [])).toBe('hello');
  });

  it('prepends the attachment block to regular prompts', () => {
    expect(buildPromptWithAttachments('look at this', ['/tmp/a.png'])).toBe(
      'Attached files:\n- /tmp/a.png\n\nlook at this'
    );
  });

  it('keeps slash commands first', () => {
    expect(buildPromptWithAttachments('/review', ['/tmp/a.png'])).toBe(
      '/review\n\nAttached files:\n- /tmp/a.png'
    );
  });

  it('returns only the attachment block when the text is empty', () => {
    expect(buildPromptWithAttachments('', ['/tmp/a.png', '/tmp/b.png'])).toBe(
      'Attached files:\n- /tmp/a.png\n- /tmp/b.png'
    );
  });
});

describe('ingestInboundImageAttachments', () => {
  let uploadDir: string;

  beforeEach(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-attachments-'));
  });

  afterEach(async () => {
    await fs.rm(uploadDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('downloads an image with the bot token and stores it in the upload dir', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi.fn(async () => makeImageResponse(bytes));

    const result = await ingestInboundImageAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://files.slack.com/files-pri/T1-F123/download/screenshot.png',
      { headers: { Authorization: 'Bearer xoxb-test' }, redirect: 'manual' }
    );
    expect(result.failed).toBe(0);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].startsWith(uploadDir)).toBe(true);
    expect(path.basename(result.paths[0])).toMatch(/^F123_screenshot_\d+\.png$/);
    expect(new Uint8Array(await fs.readFile(result.paths[0]))).toEqual(bytes);
  });

  it('ignores non-image attachments without counting them as failures', async () => {
    const fetchImpl = vi.fn();

    const result = await ingestInboundImageAttachments({
      files: [makeFile({ mimetype: 'application/pdf', name: 'doc.pdf' })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ paths: [], failed: 0 });
  });

  it('never fetches disallowed hosts and counts them as failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn();

    const result = await ingestInboundImageAttachments({
      files: [makeFile({ url_private_download: 'https://evil.example.com/a.png' })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ paths: [], failed: 1 });
    expect(warn).toHaveBeenCalled();
  });

  it('skips files whose declared size exceeds the per-file limit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn();

    const result = await ingestInboundImageAttachments({
      files: [makeFile({ size: MAX_UPLOAD_FILE_SIZE + 1 })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ paths: [], failed: 1 });
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

    const result = await ingestInboundImageAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(result).toEqual({ paths: [], failed: 1 });
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

    const result = await ingestInboundImageAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(result.failed).toBe(0);
    expect(result.paths).toHaveLength(1);
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
    // Endless image stream with no Content-Length: if the implementation
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
          headers: { 'content-type': 'image/png' },
        })
    );

    const result = await ingestInboundImageAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(result).toEqual({ paths: [], failed: 1 });
    // Reading stopped as soon as the running total crossed the 50MB ceiling.
    expect(chunksPulled).toBeLessThanOrEqual(MAX_UPLOAD_FILE_SIZE / chunkSize + 2);
    expect(await fs.readdir(uploadDir)).toEqual([]);
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

    const result = await ingestInboundImageAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(result).toEqual({ paths: [], failed: 1 });
    expect(await fs.readdir(uploadDir)).toEqual([]);
  });

  it('stores same-named files with distinct Slack IDs at distinct paths', async () => {
    const fetchImpl = vi.fn(async () => makeImageResponse(new Uint8Array([1])));

    const result = await ingestInboundImageAttachments({
      files: [makeFile({ id: 'F1', name: 'image.png' }), makeFile({ id: 'F2', name: 'image.png' })],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(result.failed).toBe(0);
    expect(result.paths).toHaveLength(2);
    expect(result.paths[0]).not.toBe(result.paths[1]);
    expect(await fs.readdir(uploadDir)).toHaveLength(2);
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

    const result = await ingestInboundImageAttachments({
      files: [makeFile()],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(result).toEqual({ paths: [], failed: 1 });
  });

  it('continues past failures and still stores the remaining images', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(makeImageResponse(bytes));

    const result = await ingestInboundImageAttachments({
      files: [
        makeFile({ id: 'F1', name: 'first.png' }),
        makeFile({ id: 'F2', name: 'second.png' }),
      ],
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(result.failed).toBe(1);
    expect(result.paths).toHaveLength(1);
    expect(path.basename(result.paths[0])).toMatch(/^F2_second_\d+\.png$/);
  });

  it('counts images beyond the per-message cap as failed without fetching them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bytes = new Uint8Array([1]);
    const fetchImpl = vi.fn(async () => makeImageResponse(bytes));
    const files = Array.from({ length: 12 }, (_, i) =>
      makeFile({ id: `F${i}`, name: `img-${i}.png` })
    );

    const result = await ingestInboundImageAttachments({
      files,
      botToken: 'xoxb-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uploadDir,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(result.paths).toHaveLength(10);
    expect(result.failed).toBe(2);
  });
});
