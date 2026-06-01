import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { shouldCompressResponse } from './compression';

function req(path: string): Request {
  return {
    path,
    url: path,
    headers: { 'accept-encoding': 'gzip, br' },
  } as Request;
}

function res(contentType?: string): Response {
  const headers = new Map<string, string>();
  if (contentType) headers.set('content-type', contentType);
  return {
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
  } as unknown as Response;
}

describe('shouldCompressResponse', () => {
  it('does not compress pass-through proxy responses', () => {
    expect(shouldCompressResponse(req('/proxies'), res('application/json'))).toBe(false);
    expect(shouldCompressResponse(req('/proxies/shortcut/stories'), res('application/json'))).toBe(
      false
    );
  });

  it('does not compress event streams', () => {
    expect(shouldCompressResponse(req('/events'), res('text/event-stream; charset=utf-8'))).toBe(
      false
    );
  });

  it('still compresses ordinary JSON responses when the client accepts compression', () => {
    expect(shouldCompressResponse(req('/health'), res('application/json; charset=utf-8'))).toBe(
      true
    );
  });
});
