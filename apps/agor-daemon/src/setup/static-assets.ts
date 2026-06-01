import path from 'node:path';
import type { Response } from 'express';

const ONE_YEAR_SECONDS = 31_536_000;
const HASHED_ASSET_RE = /[-.][a-zA-Z0-9_-]{8,}\./;

function isHashedAsset(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/');
  const basename = path.basename(filePath);
  return normalized.includes('/assets/') && HASHED_ASSET_RE.test(basename);
}

export function setBundledUiStaticHeaders(res: Response, filePath: string): void {
  if (isHashedAsset(filePath)) {
    res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
    return;
  }

  if (path.basename(filePath) === 'index.html') {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

export function setBundledUiFallbackHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-cache');
}
