/**
 * Ping handler - simple echo handler for testing IPC
 */

import type { PingParams, PingResult } from '../types.js';

export async function handlePing(_params: PingParams): Promise<PingResult> {
  return {
    pong: true,
    timestamp: Date.now(),
  };
}
