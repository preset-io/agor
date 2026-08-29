# Shared session prompting

Agor can let branch Collaborators and Managers continue Sessions created by
another person, but only when the Session uses branch-scoped SDK state.

## Authority model

Three independent conditions must hold for a foreign prompt:

1. The tenant preference `session_sharing_enabled` is on. Workspace admins
   manage it in **Settings → Workspace → Preferences**. It defaults off.
2. The effective board branch default or branch override has
   `allow_shared_session_prompts` on. Board/Branch Managers manage this switch.
3. The caller has `sessions.prompt_own` through the effective branch policy
   (the Collaborator or Manager role).

Session owners still need ordinary branch access. Superadmin status and policy
management never substitute for prompt authority.

## Session compatibility boundary

`Session.sdk_home_scope` is immutable:

- `branch`: eligible for shared prompting when both switches and branch access
  allow it.
- `execution_home`: never shareable. These Sessions may contain native tool
  state tied to their creator's private execution home. Users should start a
  new branch-home Session instead.

This immutable stamp keeps compatibility logic at Session admission and avoids
changing the mount identity of a resumable conversation later.

## Identity and state

An admitted foreign prompt:

- records the actual caller on `Task.created_by`;
- uses the caller's execution home, managed environment variables, provider
  credentials, MCP visibility, and connector credentials;
- uses the branch's filesystem projection and branch SDK home;
- continues the shared Session conversation.

It never mounts or borrows the Session creator's execution home. A fork or
spawn made by a foreign caller is attributed to that caller and inherits the
parent Session's branch SDK-home scope.

People who can prompt a Session can read its conversation and influence its
future context. That is the product warning; it is no longer a credential-home
sharing exception.

## Configuration and revocation

The tenant preference is stored in tenant-scoped `app_variables`, not
`config.yaml`. Board defaults and branch overrides store one boolean on the
complete normalized `branch_permission_configs` package, so it follows the
same inherit/override boundary as branch access.

Disabling the tenant preference also clears every board and branch opt-in in
that tenant. Re-enabling therefore cannot silently restore stale sharing.

Gateway, browser, API, MCP, scheduler, widget, fork, and spawn paths use the
same `resolveSessionPromptAuthority` result and canonical denial copy. Gateway
denials are terminal rather than retryable.

## Migration

The personal per-owner grant tables and legacy identity-borrowing JSON fields
are removed. Existing grants are intentionally not broadened into branch-wide
permission: the new tenant preference and every branch switch start off. The
table removal is an offline protocol cutover because older daemons cannot
operate against the new schema.
