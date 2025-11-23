/**
 * Global Permission Manager
 *
 * Maintains a registry of permission services across all active sessions.
 * Routes permission_resolved notifications from daemon to the correct session's PermissionService.
 */

import type { PermissionDecision, PermissionService } from './permission-service.js';

export class PermissionManager {
  private services = new Map<string, PermissionService>();

  /**
   * Register a permission service for a session
   */
  register(sessionId: string, service: PermissionService): void {
    this.services.set(sessionId, service);
    console.log(`[PermissionManager] Registered service for session ${sessionId.substring(0, 8)}`);
  }

  /**
   * Unregister a permission service
   */
  unregister(sessionId: string): void {
    this.services.delete(sessionId);
    console.log(
      `[PermissionManager] Unregistered service for session ${sessionId.substring(0, 8)}`
    );
  }

  /**
   * Route a permission decision to the correct service
   * Called by IPC notification handler
   */
  resolvePermission(decision: PermissionDecision): void {
    // Find the service by request ID (iterate through all services)
    for (const [_sessionId, service] of this.services.entries()) {
      // Try to resolve - the service will only resolve if it has this requestId
      service.resolvePermission(decision);
    }
  }
}

// Global singleton instance
export const globalPermissionManager = new PermissionManager();
