# Daemon filesystem boundary

The daemon/service layer must not acquire ambient host-filesystem authority by accident. This checker is a **pragmatic layered guard**, not proof of filesystem ownership or tenant isolation. RLS does not protect files.

## Classification

Every observed direct I/O operation has an exact registry tuple (file, import, imported symbol, local binding, and call/use identity):

- **A — valid daemon-owned local responsibility.** Deployment config, SQLite/bootstrap state, runtime assets, shutdown state, explicit local host/executor operations, and narrowly modeled security authorities whose storage is selected only from trusted server state. Exact A capabilities may set `reviewTarget` and `reviewDate` to `null` and remain indefinitely.
- **B — intentional staging boundary with lifecycle abstraction.** Temporary upload/attachment staging must have an owner, lifecycle rationale, review/removal target, and future review date.
- **C — tenant/user/session/branch violation that must move.** Workspace and user-home access is transitional and requires the same review metadata.
- **D — ambiguous product decision.** The owning team must decide the durable boundary by the review date.

Adapter placement under `apps/agor-daemon/src/host/local/` is necessary layering, **not an allowlist**. Local adapters need the same exact declarations as every other module. Host-account, POSIX-group, ACL-repair, and user-home symlink operations have been removed; managed Git and sandbox filesystem work cross typed executor boundaries.

## Checker and workflow

`scripts/check-daemon-filesystem-boundaries.mjs` starts at the production daemon entrypoint and follows local imports/re-exports plus checked-in workspace package `exports[*].source` mappings. It parses static imports, literal `require`, literal/non-literal dynamic imports, aliases, and exact calls. Its small capability manifest includes Node filesystem/process APIs and known path-capable APIs such as core Git/local actions, simple-git, multer disk storage, Express static files, watchers, and globbing. Pure `path.posix`, streams, and HTTP SDKs are not banned wholesale.

1. Classify the resource using [multitenancy.md](./multitenancy.md).
2. Prefer a narrow port and local daemon-host adapter; tenant operations need their owning storage/workspace capability.
3. Add an exact registry tuple only with a defensible A/B/C/D classification. Wildcards, duplicate IDs/tuples, malformed paths, invalid dates, expired transitional reviews, and stale declarations fail.
4. Run:

   ```bash
   pnpm test:daemon-filesystem-boundaries
   pnpm check:daemon-filesystem-boundaries
   ```

CODEOWNERS review for the checker, registry, and daemon-host adapters is a useful optional ownership layer; this change does not add it.

## Known limitations / false negatives

- The manifest is deliberately finite. A new third-party path/process API is invisible until added.
- Computed properties, reflective calls, runtime monkey-patching, generated code, native addons, and subprocess behavior hidden inside unmanifested dependencies are not fully resolved. Direct assignment aliases and higher-order/pass-through aliases of an exact imported capability (including `promisify(exec)` and promisified `open`/`write`/`close`/`unlink`) are tracked.
- Workspace traversal uses checked-in package `source` exports and relative modules; it does not inspect external `node_modules` implementations.
- Call identity uses the nearest named function/method plus an occurrence number. Refactors can require registry updates even when authority is unchanged.
- The checker verifies declared syntactic capabilities, not path provenance, tenant scoping, authorization, cleanup correctness, TOCTOU safety, or command argument safety. Those require runtime design and negative tests at the owning boundary.

## Closure status (2026-08-22)

The registry contains **124** exact capabilities (**97 A, 27 B, 0 C, 0 D**).
The only B entries remain the local upload staging adapter. Obsolete declarations
for Unix account/group management, sudo wrappers, env-file ownership, and local
OpenCode command execution were removed with those code paths. Sandbox path
canonicalization remains an explicit daemon-host capability.

The Agor state-home bootstrap is one system/global class-A boundary shared by
CLI initialization, CLI-managed daemon files, initial config publication, and
the daemon's canonical SQLite parent. It creates Agor-owned state privately but
does not apply that policy to custom database parents or silently rewrite an
existing operator-managed directory's group/ACL policy.

Runtime Git lifecycle work uses typed executor payloads. Application RBAC is
projected into sandbox mounts at launch rather than POSIX groups or ACL repair;
there are no `unix.sync-*` handlers or daemon host-identity operations.

The checker still cannot see semantic path authority. In particular, daemon services resolve tenant layout strings and carry branch/repo cwd values from tenant-owned database records into typed executor payloads. That is intentional routing data, not daemon I/O: local executor processes launch from the executor package directory, and only executor commands consume workspace cwd. Review payload schemas and executor command handlers when changing this contract, because a string passed into an unmanifested dependency or remote launcher can become filesystem authority without a syntactic daemon capability.

Executor-owned SDK session persistence and general per-user home persistence are a separate architecture concern. The one narrow exception is the HA Codex credential authority: it mutates only the server-resolved canonical tenant/user credential route, inside the database authority transaction, through an opened no-follow directory capability. Outside that explicit authority, the daemon runtime remains free of tenant repo/branch/user/session filesystem readers, writers, cwd use, and permission-command arguments.
