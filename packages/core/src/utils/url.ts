/**
 * URL normalization utilities
 *
 * Provides shared helpers for validating and normalizing user-provided URLs.
 */

import { shortId } from '../lib/ids';
import type { BoardID, SessionID } from '../types/id';

/**
 * Generate a session URL for external/user-facing links
 *
 * Prefers board slug over short ID for cleaner URLs. Falls back to short ID if slug unavailable.
 *
 * @param sessionId - Session ID (full UUID)
 * @param boardId - Board ID (required for URL generation)
 * @param boardSlug - Board slug (optional, preferred for cleaner URLs)
 * @param baseUrl - Base URL from config (e.g., "https://agor.example.com")
 * @returns Session URL or null if boardId is missing
 *
 * @example
 * ```ts
 * getSessionUrl('abc12345-...', 'board456-...', 'my-board', 'https://agor.example.com')
 * // => 'https://agor.example.com/b/my-board/abc12345'
 *
 * getSessionUrl('abc12345-...', 'board456-...', undefined, 'https://agor.example.com')
 * // => 'https://agor.example.com/b/board456/abc12345' (falls back to short ID)
 * ```
 */
export function getSessionUrl(
  sessionId: SessionID,
  boardId: BoardID | null | undefined,
  boardSlug: string | null | undefined,
  baseUrl: string
): string | null {
  if (!boardId) return null;
  const boardParam = boardSlug || shortId(boardId);
  return `${baseUrl}/b/${boardParam}/${shortId(sessionId)}`;
}

/**
 * Generate a board URL for external/user-facing links
 *
 * Prefers board slug over short ID for cleaner URLs. Falls back to short ID if slug unavailable.
 *
 * @param boardId - Board ID (full UUID)
 * @param boardSlug - Board slug (optional, preferred for cleaner URLs)
 * @param baseUrl - Base URL from config (e.g., "https://agor.example.com")
 * @returns Board URL
 *
 * @example
 * ```ts
 * getBoardUrl('board456-...', 'my-board', 'https://agor.example.com')
 * // => 'https://agor.example.com/b/my-board'
 *
 * getBoardUrl('board456-...', undefined, 'https://agor.example.com')
 * // => 'https://agor.example.com/b/board456' (falls back to short ID)
 * ```
 */
export function getBoardUrl(
  boardId: BoardID,
  boardSlug: string | null | undefined,
  baseUrl: string
): string {
  const boardParam = boardSlug || shortId(boardId);
  return `${baseUrl}/b/${boardParam}`;
}

/**
 * Normalize an optional HTTP(S) URL string.
 *
 * - Trims whitespace
 * - Returns `undefined` for empty or missing values
 * - Validates that protocol is http or https
 * - Returns canonical `.toString()` representation
 *
 * @param value - Potential URL value from user input
 * @param fieldName - Friendly field name for error messages
 * @throws Error if the URL is present but invalid or not http(s)
 */
export function normalizeOptionalHttpUrl(value: unknown, fieldName = 'value'): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${fieldName} must use http or https`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(fieldName)) {
      throw error;
    }
    throw new Error(`${fieldName} must be a valid http(s) URL`);
  }
}
