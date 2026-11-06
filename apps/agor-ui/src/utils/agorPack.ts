/**
 * Browser client for the daemon's raw `.agor` routes. Packs are binary
 * and can be large, so these use fetch/XHR with the stored bearer (refreshed
 * once on 401, like attachment uploads) instead of the Feathers socket.
 */

import type {
  AgorPackApplyRequest,
  AgorPackExportRequest,
  AgorPackImport,
  AgorPackManifest,
  AgorPackPreflightTeammate,
  AgorPackSwitchOverState,
} from '@agor/core/types';
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

/** Build the pack on the daemon, then download it as a file. */
export async function exportPack(body: AgorPackExportRequest): Promise<AgorPackExportResult> {
  const result = await json<AgorPackExportResult>('/agor-pack/exports', body);
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

/** Upload a pack with progress; resolves to the dry-run receipt. */
export async function uploadPack(
  file: File,
  onProgress?: (percent: number) => void
): Promise<AgorPackImport> {
  const send = (token: string | null) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${daemonUrl()}/agor-pack/uploads`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => reject(new Error('Upload failed: the daemon could not be reached'));
      xhr.send(file);
    });
  let result = await send(await bearer());
  if (result.status === 401) result = await send(await bearer(true));
  if (result.status < 200 || result.status >= 300) {
    let message = `Upload failed (${result.status})`;
    try {
      message = (JSON.parse(result.body) as { error?: string }).error ?? message;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  return JSON.parse(result.body) as AgorPackImport;
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
