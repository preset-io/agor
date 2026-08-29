# Personal session sharing

**Status:** branch-home Sessions use ordinary branch collaboration;
execution-home Sessions retain the normalized owner-authored compatibility
policy, with workspace opt-in off by default.

## Why sharing is dangerous

Historical native Claude Code, Codex, Gemini, and similar conversations are not portable
database records. Their conversation state lives in files below the session
owner's home, such as `~/.claude/` and `~/.codex/`. Continuing a native
conversation therefore requires the executor to keep using that owner's home.

That home can contain much more than the selected conversation:

- native session history and metadata for other sessions;
- dotfiles, caches, scripts, repositories, and arbitrary files left by users
  or agents;
- tool-managed credentials. For example, Codex subscription mode stores
  credential material in `~/.codex/auth.json`.

An agent operating in the shared home can potentially inspect, change, or
break those files even when no browser terminal is available. Terminal denial
is not a security boundary against agent tools.

## Why the feature exists

Some workspaces have high trust between members and value continuing the exact
native conversation. Other deployments use deliberately shared identities,
such as a team service account or a Slack-facing assistant whose home is
treated as shared infrastructure. Agor lets workspace administrators make that
trade-off explicitly rather than pretending the home can be transferred
safely.

The safer alternative is to grant read access to the original session and have
the colleague create a new session under their own home, referencing the prior
conversation in a prompt such as “read the sibling session and continue from
where it stopped.” Per-session homes are the long-term direction.

## Authorization model

Every Session has an immutable `sdk_home_scope`:

- `branch`: a caller with `sessions.prompt_own` (normally Collaborator or
  Manager) may prompt it. Execution uses the actual caller's identity and
  caller-scoped credentials while SDK state comes from the branch home.
- `execution_home`: the compatibility rules below apply because resuming the
  conversation requires access to the Session owner's home.

The scope is stamped when an independent Session is admitted. Existing
Sessions are backfilled to `execution_home`; forked and spawned children inherit
their parent's scope. This explicit seam avoids guessing from creation dates or
the live deployment flag.

Execution-home sharing has two independent gates:

1. The tenant-managed Workspace Preference
   `personal_session_sharing_enabled`, which defaults to false.
2. An enabled rule authored by the user whose sessions/home will be shared.

Rules are part of `BranchPermissionConfig`, so a board's branch template can
express “Bob may prompt all sessions I own on branches using these defaults.” A
branch inherits or overrides the entire package; session sharing never has its
own independent inherit switch. Switching to override clones the current board
template before edits.

Each rule contains one `session_owner_user_id` and named user/group grantees.
Only that owner may change the rule. Managers and other owners see foreign
rules read-only and cannot erase them by changing a branch binding. Group
membership is resolved at authorization time.

To prompt a foreign execution-home Session, the caller must both:

- have `sessions.prompt_own` through the effective branch policy; and
- match an enabled rule belonging to that session's owner while the workspace
  gate is on.

Branch Manager alone never implies authority over an execution-home Session.

## Runtime identity split

For an allowed shared execution-home prompt:

| Concern                              | Identity used |
| ------------------------------------ | ------------- |
| `session.created_by` and genealogy   | session owner |
| native agent-tool home (`~/`)        | session owner |
| `task.created_by` and prompt label   | actual caller |
| Agor-managed environment variables   | actual caller |
| private/global MCP definitions       | actual caller |
| per-user OAuth/connector credentials | actual caller |
| branch filesystem read/write mount   | actual caller |

The distinction matters: Agor does not inject the owner's managed secrets, but
credentials stored as ordinary files inside the owner's shared home are still
exposed by the home itself.

`CapabilityPolicyRepository.resolveSessionPromptAuthority` is the canonical
point check. REST prompt admission, Feathers hooks, widgets, MCP tools, task
tokens, executors, and OAuth-header hydration use the resulting identity split.

## Lifecycle rules

- Board templates and branch overrides store owner rules in normalized rows.
- Board deletion materializes inherited branch packages before detaching them.
- Archive/unarchive retains policy and sharing state.
- Export/clone operations intentionally omit named principals and sharing
  grants; importing cannot recreate cross-tenant or foreign-home authority.
- Primary ownership is immutable. No custody transfer or session-home migration
  exists in this remodel.
- Hard user deletion must fail elsewhere while protected objects remain. User
  deactivation is the near-term offboarding mechanism.

## User-facing explanation

The UI copy and FAQ should make these points without implying more isolation
than exists:

- listed people prompt from the owner's `~/`;
- prompts remain labeled with the actual caller and use that caller's
  Agor-managed credentials;
- the home may expose all native session metadata and home-resident credentials;
- use only with high trust and an understanding of the home's contents;
- a separate session under the colleague's own home is the safer alternative.

See [`apps/agor-docs/content/faq.mdx`](../../apps/agor-docs/content/faq.mdx#session-sharing-home-access).
