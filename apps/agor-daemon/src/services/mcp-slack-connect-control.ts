/**
 * The Slack MCP connect card's kill switch, as an operator control.
 *
 * `isMCPSlackConnectCardEnabled` / `setMCPSlackConnectCardEnabled` are a
 * predicate and a setter over one app variable. That is enough for the lane to
 * read and not enough for anyone to USE: before this, turning the projection
 * off during an incident meant writing an app variable by hand, and verifying
 * it meant reading one back the same way. A switch nobody can reach is not a
 * control, and §7.1.4 promised one.
 *
 * Four things an operator needs, and all four are here rather than in a
 * runbook's shell snippets:
 *
 *  1. read the current value, for an explicit tenant;
 *  2. change it;
 *  3. verify it took effect — which is why `patch` RE-READS through the same
 *     predicate the lane itself calls rather than echoing the request;
 *  4. know which tenant they just acted on, which is what makes working
 *     through several of them auditable.
 *
 * Kept out of `register-routes.ts` so all of that is testable against a real
 * database rather than only against the route's registration. The route is the
 * thin part: it supplies the admin floors and the tenant-scoped hooks.
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.1.4 for the
 * procedure this exists for, including what happens to work stranded while the
 * card is off.
 */

import {
  getCurrentTenantId,
  isMCPSlackConnectCardEnabled,
  setMCPSlackConnectCardEnabled,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { UserID } from '@agor/core/types';

/** What both methods answer: the switch, and the tenant it belongs to. */
export interface MCPSlackConnectCardControlState {
  tenant_id: string | undefined;
  enabled: boolean;
}

interface ControlParams {
  tenant?: { tenant_id?: string };
  user?: { user_id?: string };
}

export interface MCPSlackConnectCardControl {
  find(params?: ControlParams): Promise<MCPSlackConnectCardControlState>;
  patch(
    id: unknown,
    data: { enabled?: unknown } | undefined,
    params?: ControlParams
  ): Promise<MCPSlackConnectCardControlState>;
}

export function createMCPSlackConnectCardControl(
  db: TenantScopeAwareDatabase
): MCPSlackConnectCardControl {
  const tenantOf = (params?: ControlParams) => params?.tenant?.tenant_id ?? getCurrentTenantId();
  return {
    async find(params) {
      return { tenant_id: tenantOf(params), enabled: await isMCPSlackConnectCardEnabled(db) };
    },
    async patch(_id, data, params) {
      // A boolean or nothing. The predicate leaves an unrecognised value ON,
      // deliberately (§7.1.4), and this is the one writer in the product — so
      // it must not be the thing that writes an unrecognised value.
      if (typeof data?.enabled !== 'boolean') {
        throw new BadRequest('enabled must be true or false');
      }
      const tenantId = tenantOf(params);
      await setMCPSlackConnectCardEnabled(db, data.enabled, params?.user?.user_id as UserID);
      console.warn(
        `[SECURITY] event=mcp_slack_connect_card_toggled tenant_id=${tenantId ?? '<unknown>'} ` +
          `actor_user_id=${params?.user?.user_id ?? '<unknown>'} enabled=${data.enabled}`
      );
      // Read back, never echo. "Did it take effect" is the question being
      // asked, and the only answer worth giving is what the predicate the lane
      // calls says now.
      return { tenant_id: tenantId, enabled: await isMCPSlackConnectCardEnabled(db) };
    },
  };
}
