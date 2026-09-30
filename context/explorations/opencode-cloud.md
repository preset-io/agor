# OpenCode in hosted workspaces

Hosted OpenCode is on by default (`agentic_tools.opencode_hosted_native_state: disabled`
opts out) and requires auth-derived tenancy, delegated execution with a command template, and
a persistent per-user executor home. `resolveOpenCodeCapabilities`
(`packages/agentic-tool-opencode/src/daemon/capabilities.ts`) is the only place
that decides; every consumer reads it and unsupported deployments report one
structured reason.

## Boundaries

- **Owner only.** The prompting user must be the Session creator (unchanged local
  rule). Branch-scoped OpenCode Sessions stay refused.
- **Single-key providers.** `hosted-providers.generated.ts` is a snapshot of the pinned
  OpenCode's providers that need exactly one API key, a bundled SDK, and no local URL,
  keeping only tool-calling text models
  (`packages/agor-opencode/scripts/generate-hosted-providers.mjs`, rerun on every bump).
  Keys live in the caller's encrypted `users.data.agentic_tools.opencode[<provider id>]`.
  `beginOpenCodeCheckpoint` returns only the owner's key for the Session's selected
  provider; the executor writes it to a mode-0600 `auth.json` on scratch, never into a
  process environment.
- **Sealed configuration.** All XDG roots and `OPENCODE_DB` point at Job-local
  scratch (`AGOR_OPENCODE_SCRATCH_ROOT`, no fallback). Project/home/system config
  discovery, plugins, provider overrides, and local MCP commands are refused.

## Native state

OpenCode keeps each conversation in SQLite (WAL), which must not run live on the
network filesystem behind the owner's home. Each turn:

1. `tasks.beginOpenCodeCheckpoint` admits one holder per Task (a duplicate
   executor gets `duplicate` and exits without side effects) and returns the
   Session's accepted checkpoint, a bounded cleanup list, and the owner's key for the
   Session's selected provider.
2. The executor copies the accepted file to scratch and verifies its digest.
   Missing or altered state fails the turn; it never starts an empty conversation.
3. OpenCode runs on scratch. After the server exits, `node:sqlite` folds the WAL,
   checks integrity and that the completed native session exists, and the file is
   copied to `$HOME/.agor/opencode/sessions/<session>/attempts/<task>/` (the
   attempt directory is created exclusively).
4. The completion patch carries `opencode_checkpoint`. Inside the locked task
   update, `acceptOpenCodeCheckpoint` requires a non-terminal Task, the admitted
   holder, a manifest for this Task, and that the turn's input is still the
   accepted attempt; it then supersedes the old attempt and accepts the new one.

The ledger is `opencode_checkpoint_attempts` (no foreign keys, additive
migration). Correctness rests on: unique per-Task attempt paths, acceptance only
in the completion transaction, terminal Tasks never completing, and one active
Task per Session. Cleanup therefore needs no proof that old executors exited: it
removes only attempts the ledger says can never be restored (superseded, never
accepted by a now-terminal Task, or belonging to a deleted Session), by exact
path, during the owner's later admitted turns. A stale executor can at worst
leave an orphaned file behind; that leak is accepted and there is no erasure
guarantee.

## Out of scope

Shared prompting, OAuth or custom endpoints, providers needing more than one key,
explicit erasure of native state, closure proof, and fork/import of native state.
Cloud supplies only the scratch volume and its pinned environment variable.
