/**
 * Slack App Manifest generator
 *
 * Pure, dependency-free derivation of the Slack OAuth bot scopes, event
 * subscriptions, and a complete app manifest from a small set of capability
 * toggles. The output is the full manifest JSON a user can paste into Slack's
 * "Create app from manifest" flow — no scope or event needs to be added by
 * hand. The only manual step left to the user is generating the app-level
 * token (`connections:write`), which is not a bot scope and therefore never
 * appears in this manifest.
 *
 * The scope/event matrix mirrors what the Slack connector actually calls; see
 * {@link ./slack.ts}. DMs are always handled, so there is no DM toggle, and
 * channel-like surfaces trigger exclusively on `app_mention` (verified in the
 * connector's inbound filter), so no `message.channels`/`groups`/`mpim` events
 * are requested.
 */

import {
  resolveSlackAgentTools,
  type SlackAgentToolCapability,
  type SlackAgentToolsConfig,
} from '../../types/gateway';

export interface SlackWizardOptions {
  appName: string;
  botDisplayName?: string;
  /** Listen in public channels (`#channel`). */
  publicChannels: boolean;
  /** Listen in private channels (groups). */
  privateChannels: boolean;
  /** Listen in group DMs (multi-person IMs). */
  groupDms: boolean;
  /** Resolve Slack user email → Agor user (requires reading user emails). */
  alignUsers: boolean;
  /** Proactive outbound: post to channels by name and DM users by email. */
  outbound: boolean;
  /** Ingest files attached to inbound messages (screenshots/images). */
  ingestFiles: boolean;
  /** Agent-callable MCP tool toggles (maps to `config.agent_tools`). */
  agentTools: SlackAgentToolsConfig;
}

/**
 * Slack OAuth bot scopes each agent-tool capability requires. The single
 * source of truth tying a capability toggle to the scopes its MCP tool needs:
 * `requiredBotScopes` consumes it, so enabling a capability in the wizard and
 * gating the tool at call time can never drift apart.
 *
 * `thread_history` contributes no scopes of its own — mapped threads only
 * exist on surfaces the bot listens to, and each listening surface already
 * carries its history scope (DMs via the `im:history` baseline).
 */
export const SLACK_AGENT_TOOL_SCOPES: Record<SlackAgentToolCapability, string[]> = {
  thread_history: [],
  channel_history: ['channels:history', 'groups:history', 'mpim:history'],
  reactions: ['reactions:write'],
  file_upload: ['files:write'],
  file_download: ['files:read'],
};

/**
 * Slack app ids are an "A" followed by uppercase alphanumerics (e.g.
 * "A0BH0A7TUGJ"); team ids are the same shape behind a "T" (workspace) or "E"
 * (enterprise org) prefix. Anything else is treated as unresolved: both ids
 * land in a URL path, so these shape checks are what keep a malformed/hostile
 * value (slashes, query/fragment chars) from steering the link somewhere else.
 */
const SLACK_APP_ID_SHAPE = /^A[A-Z0-9]+$/;
const SLACK_TEAM_ID_SHAPE = /^[TE][A-Z0-9]+$/;

/** Generic Slack app list — the fallback when no manifest deep link can be built. */
export const SLACK_APPS_URL = 'https://api.slack.com/apps';

/**
 * URL of a Slack app's manifest editor when the app AND team ids are known,
 * falling back to the generic app list otherwise. The manifest editor lives on
 * the workspace-scoped app-settings surface — the per-app
 * `api.slack.com/apps/{id}` path 404s — so the team id is required for the
 * deep link. An app id without a team id doesn't occur in practice: the app id
 * is only resolved after an `auth.test` that also supplies the team id.
 */
export function slackAppManifestUrl(appId?: string | null, teamId?: string | null): string {
  return appId && SLACK_APP_ID_SHAPE.test(appId) && teamId && SLACK_TEAM_ID_SHAPE.test(teamId)
    ? `https://app.slack.com/app-settings/${teamId}/${appId}/app-manifest`
    : SLACK_APPS_URL;
}

export interface SlackBotEventSubscriptions {
  bot_events: string[];
}

export interface SlackAppManifest {
  display_information: {
    name: string;
  };
  features: {
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
    app_home: {
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
      home_tab_enabled: boolean;
    };
  };
  oauth_config: {
    scopes: {
      bot: string[];
    };
  };
  settings: {
    event_subscriptions: SlackBotEventSubscriptions;
    interactivity: {
      is_enabled: boolean;
    };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

/** Any channel-like surface (public/private/group-DM) shares the @mention trigger. */
function hasChannelLikeSurface(opts: SlackWizardOptions): boolean {
  return opts.publicChannels || opts.privateChannels || opts.groupDms;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Bot OAuth scopes required for the selected capabilities, de-duplicated and
 * stable-sorted. Derived from the connector's Web API usage.
 */
export function requiredBotScopes(opts: SlackWizardOptions): string[] {
  // Baseline: DM handling (always on) + user profile lookups + sending.
  const scopes = ['chat:write', 'im:history', 'im:read', 'users:read'];

  if (hasChannelLikeSurface(opts)) {
    scopes.push('app_mentions:read');
  }
  if (opts.publicChannels) {
    scopes.push('channels:history', 'channels:read');
  }
  if (opts.privateChannels) {
    scopes.push('groups:history', 'groups:read');
  }
  if (opts.groupDms) {
    scopes.push('mpim:history', 'mpim:read');
  }
  if (opts.alignUsers) {
    scopes.push('users:read.email');
  }
  if (opts.ingestFiles) {
    scopes.push('files:read');
  }
  if (opts.outbound) {
    // Outbound name resolution lists public+private channels and opens DMs by
    // email, independent of inbound listening.
    scopes.push(
      'chat:write.public',
      'channels:read',
      'groups:read',
      'im:write',
      'users:read.email'
    );
  }

  const agentTools = resolveSlackAgentTools(opts.agentTools);
  for (const capability of Object.keys(SLACK_AGENT_TOOL_SCOPES) as SlackAgentToolCapability[]) {
    if (agentTools[capability]) {
      scopes.push(...SLACK_AGENT_TOOL_SCOPES[capability]);
    }
  }

  return sortedUnique(scopes);
}

/**
 * Bot event subscriptions required for the selected capabilities,
 * de-duplicated and stable-sorted. Channel-like surfaces trigger only on
 * `app_mention`; DMs trigger on `message.im`.
 */
export function requiredBotEvents(opts: SlackWizardOptions): string[] {
  const events = ['message.im'];

  if (hasChannelLikeSurface(opts)) {
    events.push('app_mention');
  }

  return sortedUnique(events);
}

/**
 * Build the complete Slack app manifest for the selected capabilities.
 *
 * Socket Mode is enabled, so no request URLs or signing secret are emitted.
 * Interactivity is disabled because the connector uses no interactive components.
 * The assistant view is omitted because the connector does not handle assistant
 * lifecycle events.
 */
export function buildSlackManifest(opts: SlackWizardOptions): SlackAppManifest {
  return {
    display_information: {
      name: opts.appName,
    },
    features: {
      bot_user: {
        display_name: opts.botDisplayName ?? opts.appName,
        always_online: true,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
        home_tab_enabled: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: requiredBotScopes(opts),
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: requiredBotEvents(opts),
      },
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
