/**
 * Browser client for the daemon's raw `.agor` routes. Packs are binary
 * and can be large, so these use fetch with the stored bearer (refreshed once
 * on 401, like attachment uploads) instead of the Feathers socket.
 */

import { uploadPackChunked } from '@agor/core/agor-pack/upload-client';
import {
  AGOR_PACK,
  type AgorPackApplyRequest,
  type AgorPackExportRequest,
  type AgorPackImport,
  type AgorPackManifest,
  type AgorPackPreflightTeammate,
  type AgorPackSwitchOverState,
} from '@agor/core/types';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { getDaemonUrl } from '../config/daemon';
import { isExpiringSoon } from './jwtExpiry';
import { readStoredCredentialOwner, refreshStoredAccessTokenForOwner } from './storedTokenRecovery';
import { ACCESS_TOKEN_KEY } from './tokenRefresh';

export interface AgorPackExportResult {
  export_id: string;
  ref: string;
  size: number;
  filename: string;
  manifest: AgorPackManifest;
}

export interface AgorPackSwitchOverResult {
  branch_id: string;
  switch_over: AgorPackSwitchOverState | null;
  warnings: string[];
}

function daemonUrl(): string {
  return getDaemonUrl().replace(/\/$/, '');
}

async function bearer(forceRefresh = false): Promise<string | null> {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  const owner = readStoredCredentialOwner(token);
  if (owner && token && (forceRefresh || isExpiringSoon(token, 30_000))) {
    return (await refreshStoredAccessTokenForOwner(daemonUrl(), owner)) ?? token;
  }
  return token;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string | null) =>
    fetch(`${daemonUrl()}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  let response = await send(await bearer());
  if (response.status === 401) response = await send(await bearer(true));
  if (!response.ok) throw new Error(await errorMessage(response));
  return response;
}

async function json<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  return (await response.json()) as T;
}

export function fetchPackPreflight(branchIds: string[]): Promise<AgorPackPreflightTeammate[]> {
  return json<{ teammates: AgorPackPreflightTeammate[] }>(
    `/agor-pack/preflight?branch_ids=${encodeURIComponent(branchIds.join(','))}`
  ).then((result) => result.teammates);
}

/** Build the pack on the daemon, then (unless `download: false`) download it as a file. */
export async function exportPack(
  body: AgorPackExportRequest,
  { download = true }: { download?: boolean } = {}
): Promise<AgorPackExportResult> {
  const result = await json<AgorPackExportResult>('/agor-pack/exports', body);
  if (!download) return result;
  const response = await request(
    `/agor-pack/downloads/${result.export_id}/${result.ref}?filename=${encodeURIComponent(result.filename)}`
  );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.filename;
  link.click();
  URL.revokeObjectURL(url);
  return result;
}

/** SHA-256 of a file, read in chunk-sized slices (packs can be 2 GB). */
async function fileSha256(file: Blob, onProgress?: (read: number) => void): Promise<string> {
  const hash = sha256.create();
  for (let start = 0; start < file.size; start += AGOR_PACK.chunkBytes) {
    const slice = file.slice(start, Math.min(file.size, start + AGOR_PACK.chunkBytes));
    hash.update(new Uint8Array(await slice.arrayBuffer()));
    onProgress?.(Math.min(file.size, start + AGOR_PACK.chunkBytes));
  }
  return bytesToHex(hash.digest());
}

export type PackUploadPhase = 'checking' | 'uploading';

/**
 * Upload a pack with the resumable chunked protocol; resolves to the dry-run
 * receipt. Calling it again with the same file after a failure sends only the
 * chunks the daemon doesn't have yet.
 */
export async function uploadPack(
  file: File,
  onProgress?: (percent: number, phase: PackUploadPhase) => void,
  signal?: AbortSignal
): Promise<AgorPackImport> {
  const percent = (part: number) => (file.size ? Math.floor((part / file.size) * 100) : 100);
  const digest = await fileSha256(file, (read) => onProgress?.(percent(read), 'checking'));
  return uploadPackChunked({
    size: file.size,
    sha256: digest,
    readChunk: async (start, end) => file.slice(start, end),
    send: async (path, init) => {
      const send = async (token: string | null) =>
        fetch(`${daemonUrl()}${path}`, {
          method: init.method,
          body: init.body as BodyInit | undefined,
          signal,
          headers: {
            ...(init.headers ?? {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      const response = await send(await bearer());
      return response.status === 401 ? send(await bearer(true)) : response;
    },
    onProgress: (sent) => onProgress?.(percent(sent), 'uploading'),
    signal,
  });
}

export function getPackImport(importId: string): Promise<AgorPackImport> {
  return json<AgorPackImport>(`/agor-pack/imports/${importId}`);
}

export function applyPackImport(
  importId: string,
  body: AgorPackApplyRequest
): Promise<AgorPackImport> {
  return json<AgorPackImport>(`/agor-pack/imports/${importId}/apply`, body);
}

export function switchOverTeammate(
  branchId: string,
  undo: boolean
): Promise<AgorPackSwitchOverResult> {
  return json<AgorPackSwitchOverResult>(`/agor-pack/switch-over/${branchId}`, { undo });
}
