import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { errorHandler } from '@agor/core/feathers';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasBrotliContentEncoding, rejectBrotliRequestBodies } from './request-encoding';

describe('hasBrotliContentEncoding', () => {
  it('detects br alone, in a coding list, and in any case', () => {
    expect(hasBrotliContentEncoding('br')).toBe(true);
    expect(hasBrotliContentEncoding('gzip, br')).toBe(true);
    expect(hasBrotliContentEncoding(' BR ')).toBe(true);
  });

  it('ignores other codings and a missing header', () => {
    expect(hasBrotliContentEncoding(undefined)).toBe(false);
    expect(hasBrotliContentEncoding('identity')).toBe(false);
    expect(hasBrotliContentEncoding('gzip, deflate')).toBe(false);
  });
});

describe('rejectBrotliRequestBodies', () => {
  let baseUrl: string;
  let close: () => void;

  beforeAll(async () => {
    const app = express();
    app.use(rejectBrotliRequestBodies());
    app.use(express.json());
    app.post('/echo', (req, res) => {
      res.json(req.body);
    });
    app.use(errorHandler({ logger: false }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });

  afterAll(() => close());

  const post = (body: Buffer | string, contentEncoding?: string) =>
    fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(contentEncoding ? { 'content-encoding': contentEncoding } : {}),
      },
      body,
    });

  it('answers 415 before the JSON parser decompresses a Brotli body', async () => {
    const response = await post(brotliCompressSync(Buffer.from('{"a":1}')), 'br');
    expect(response.status).toBe(415);
    expect(response.headers.get('accept-encoding')).toBe('gzip, deflate');
    expect(await response.json()).toMatchObject({ name: 'UnsupportedMediaType', code: 415 });
  });

  it('matches the coding case-insensitively, as the JSON parser does', async () => {
    const response = await post(brotliCompressSync(Buffer.from('{"a":1}')), 'BR');
    expect(response.status).toBe(415);
  });

  it('still accepts plain and gzip bodies', async () => {
    const plain = await post('{"a":1}');
    expect(await plain.json()).toEqual({ a: 1 });
    const gzip = await post(gzipSync('{"a":2}'), 'gzip');
    expect(await gzip.json()).toEqual({ a: 2 });
  });
});
