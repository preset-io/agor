import type { Database, TenantScopedDatabase } from '../client';
import { AppVariableRepository } from './app-variables';

/**
 * Operator kill switch for the Slack projection of the MCP connect widget.
 *
 * Same shape as `mcp-egress-settings.ts` — one app variable, read through a
 * predicate — because it answers the same kind of question: a lane that talks
 * to a third party on a user's behalf should be stoppable without a deploy.
 * The reactive recovery lane has `isMcpRuntimeRecoveryEnabled`; this is the
 * intent-initiated lane's equivalent.
 *
 * What it disables is the PROJECTION only: posting and editing the Block Kit
 * card, issuing the sealed link it carries, and redeeming one. The canvas
 * widget lane and the `session_url` the tool relays back to the agent are
 * untouched, because they are the fallback — turning the card off must leave
 * a Slack user a way to connect, not take the feature away.
 */
export const MCP_SLACK_CONNECT_SETTINGS_NAMESPACE = 'mcp-slack-connect';
export const MCP_SLACK_CONNECT_CARD_KEY = 'card_projection';

/**
 * Anything other than an explicit off-word leaves the card on.
 *
 * Deliberately not fail-closed. An unreadable or mistyped setting should not
 * silently retire a user-facing affordance a thread is already showing; the
 * operator turning this off is performing a deliberate act and can spell it.
 */
const OFF_VALUES = new Set(['off', 'false', '0', 'disabled', 'no']);

export async function isMCPSlackConnectCardEnabled(
  db: Database | TenantScopedDatabase
): Promise<boolean> {
  const raw = await new AppVariableRepository(db as Database).getPlain(
    MCP_SLACK_CONNECT_SETTINGS_NAMESPACE,
    MCP_SLACK_CONNECT_CARD_KEY
  );
  return !OFF_VALUES.has((raw ?? '').trim().toLowerCase());
}

export async function setMCPSlackConnectCardEnabled(
  db: Database | TenantScopedDatabase,
  enabled: boolean,
  updatedBy?: string
): Promise<void> {
  await new AppVariableRepository(db as Database).set({
    namespace: MCP_SLACK_CONNECT_SETTINGS_NAMESPACE,
    key: MCP_SLACK_CONNECT_CARD_KEY,
    value: enabled ? 'on' : 'off',
    content_type: 'text/plain',
    updated_by: updatedBy as import('../../types').UserID | undefined,
  });
}
