/**
 * Global Input Request Manager
 *
 * Maintains a registry of input request services across all active sessions.
 * Routes input_resolved notifications from daemon to the correct session's InputRequestService.
 */

import type { InputRequestService, InputResponse } from './input-request-service.js';

export class InputRequestManager {
  private services = new Map<string, InputRequestService>();

  /**
   * Register an input request service for a session
   */
  register(sessionId: string, service: InputRequestService): void {
    this.services.set(sessionId, service);
    console.log(
      `[InputRequestManager] Registered service for session ${sessionId.substring(0, 8)}`
    );
  }

  /**
   * Unregister an input request service
   */
  unregister(sessionId: string): void {
    this.services.delete(sessionId);
    console.log(
      `[InputRequestManager] Unregistered service for session ${sessionId.substring(0, 8)}`
    );
  }

  /**
   * Route an input response to the correct service
   * Called by IPC notification handler
   */
  resolveInput(response: InputResponse): void {
    // Find the service by request ID (iterate through all services)
    for (const [_sessionId, service] of this.services.entries()) {
      // Try to resolve - the service will only resolve if it has this requestId
      service.resolveInput(response);
    }
  }
}

// Global singleton instance
export const globalInputRequestManager = new InputRequestManager();
