import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class RemoteBridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'RemoteBridgeError';
    this.code = code;
  }
}

export function createResourceMarker(tenantId, branchId) {
  const digest = createHash('sha256').update(`${tenantId}\0${branchId}`).digest('hex').slice(0, 32);
  return `agor-${digest}`;
}

export function sanitizeProviderOutput(value, { maxBytes = 16_384, maxLines = 100 } = {}) {
  const text = String(value ?? '')
    .replace(/^\s*AGOR_FACT\s+.*$/gim, '[provider control line omitted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[REDACTED]')
    .replace(/\b(Bearer|token)\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access_token|auth|key|signature|token)=)[^&#\s]+/gi, '$1[REDACTED]');
  const lines = text.split(/\r?\n/).slice(-maxLines).join('\n');
  return Buffer.from(lines).subarray(0, maxBytes).toString('utf8');
}

export function validateRequest(rawRequest) {
  if (!rawRequest || typeof rawRequest !== 'object') {
    throw new RemoteBridgeError('INVALID_REQUEST', 'A structured lifecycle request is required');
  }

  const request = {
    action: rawRequest.action,
    tenantId: rawRequest.tenantId,
    branchId: rawRequest.branchId,
    actorUserId: rawRequest.actorUserId,
    credentialOwnerUserId: rawRequest.credentialOwnerUserId,
    credentialOwnerLogin: rawRequest.credentialOwnerLogin,
    operationId: rawRequest.operationId,
    generation: rawRequest.generation,
    repository: rawRequest.repository,
    providerRepositoryId: rawRequest.providerRepositoryId,
    ref: rawRequest.ref,
    lastKnownResourceName: rawRequest.lastKnownResourceName,
    isAttemptCurrent: rawRequest.isAttemptCurrent,
  };
  for (const field of [
    'tenantId',
    'branchId',
    'actorUserId',
    'credentialOwnerUserId',
    'operationId',
  ]) {
    if (!UUID_PATTERN.test(request[field])) {
      throw new RemoteBridgeError('INVALID_REQUEST', `${field} must be a UUID`);
    }
  }
  if (!['start', 'stop', 'health', 'logs', 'nuke'].includes(request.action)) {
    throw new RemoteBridgeError('INVALID_ACTION', 'Unsupported lifecycle action');
  }
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
    throw new RemoteBridgeError('INVALID_REQUEST', 'generation must be a positive integer');
  }
  if (!REPOSITORY_PATTERN.test(request.repository ?? '') || request.repository.length > 200) {
    throw new RemoteBridgeError('INVALID_REQUEST', 'repository must be an owner/name pair');
  }
  if (!isSafeProviderIdentifier(request.credentialOwnerLogin, 100)) {
    throw new RemoteBridgeError('INVALID_REQUEST', 'credentialOwnerLogin is invalid');
  }
  if (request.providerRepositoryId !== undefined) {
    request.providerRepositoryId = String(request.providerRepositoryId);
    if (!/^\d+$/.test(request.providerRepositoryId)) {
      throw new RemoteBridgeError('INVALID_REQUEST', 'providerRepositoryId must be numeric');
    }
  }
  if (
    request.lastKnownResourceName !== undefined &&
    !isSafeProviderIdentifier(request.lastKnownResourceName, 200)
  ) {
    throw new RemoteBridgeError('INVALID_REQUEST', 'lastKnownResourceName is invalid');
  }
  if (typeof request.ref !== 'string' || request.ref.length === 0 || request.ref.length > 1024) {
    throw new RemoteBridgeError('INVALID_REQUEST', 'ref is required');
  }
  if (
    [...request.ref].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new RemoteBridgeError('INVALID_REQUEST', 'ref contains control characters');
  }
  if (typeof request.isAttemptCurrent !== 'function') {
    throw new RemoteBridgeError(
      'INVALID_REQUEST',
      'isAttemptCurrent is required so stale lifecycle attempts fail closed'
    );
  }
  return request;
}

export function validateCodespacesAccess(rawAccess) {
  if (!rawAccess) return {};
  const editorUrl = rawAccess.editorUrl ? validateGithubDevUrl(rawAccess.editorUrl) : undefined;
  const accessUrls = (rawAccess.accessUrls ?? []).map((entry) => ({
    name: String(entry.name).slice(0, 80),
    url: validateGithubDevUrl(entry.url),
    visibility: ['private', 'org', 'public'].includes(entry.visibility)
      ? entry.visibility
      : 'unknown',
  }));
  return { editorUrl, accessUrls };
}

export function sameIdentifier(left, right) {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function validateGithubDevUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteBridgeError(
      'INVALID_ACCESS_URL',
      'The provider returned an invalid access URL'
    );
  }
  const allowedHost = url.hostname === 'github.dev' || url.hostname.endsWith('.github.dev');
  if (
    url.protocol !== 'https:' ||
    !allowedHost ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RemoteBridgeError(
      'INVALID_ACCESS_URL',
      'The provider access URL violates the Codespaces URL policy'
    );
  }
  return url.toString();
}

function isSafeProviderIdentifier(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\s\0]/.test(value)
  );
}
