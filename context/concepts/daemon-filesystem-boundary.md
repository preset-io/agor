# Daemon filesystem boundary

The daemon/service layer must not acquire ambient host-filesystem authority by accident. This checker is a **pragmatic layered guard**, not proof of filesystem ownership or tenant isolation. RLS does not protect files.

## Classification

Every observed direct I/O operation has an exact registry tuple (file, import, imported symbol, local binding, and call/use identity):

- **A — valid Cell/operator local responsibility.** Deployment config, SQLite/bootstrap state, runtime assets, shutdown state, and explicit local host/executor operations. Exact A capabilities may set `reviewTarget` and `reviewDate` to `null` and remain indefinitely.
- **B — intentional staging boundary with lifecycle abstraction.** Temporary upload/attachment staging must have an owner, lifecycle rationale, review/removal target, and future review date.
- **C — tenant/user/session/branch violation that must move.** Workspace and user-home access is transitional and requires the same review metadata.
- **D — ambiguous product decision.** The owning team must decide the durable boundary by the review date.

Adapter placement under `apps/agor-daemon/src/cell/local/` is necessary layering, **not an allowlist**. Local adapters need the same exact declarations as every other module. Privileged identity/group operations implement `CellHostIdentityOperations`; home-symlink and Git-repair maintenance use the separate `CellHostMaintenanceOperations` capability. Hosted mode does not register either service, and these operations must never be delegated to an ordinary user-impersonated executor.

## Checker and workflow

`scripts/check-daemon-filesystem-boundaries.mjs` starts at the production daemon entrypoint and follows local imports/re-exports plus checked-in workspace package `exports[*].source` mappings. It parses static imports, literal `require`, literal/non-literal dynamic imports, aliases, and exact calls. Its small capability manifest includes Node filesystem/process APIs and known path-capable APIs such as core Git/local actions, simple-git, multer disk storage, Express static files, watchers, and globbing. Pure `path.posix`, streams, and HTTP SDKs are not banned wholesale.

1. Classify the resource using [multitenancy.md](./multitenancy.md).
2. Prefer a narrow port and local Cell adapter; tenant operations need their owning storage/workspace capability.
3. Add an exact registry tuple only with a defensible A/B/C/D classification. Wildcards, duplicate IDs/tuples, malformed paths, invalid dates, expired transitional reviews, and stale declarations fail.
4. Run:

   ```bash
   pnpm test:daemon-filesystem-boundaries
   pnpm check:daemon-filesystem-boundaries
   ```

CODEOWNERS review for the checker, registry, and Cell adapters is a useful optional ownership layer; this change does not add it.

## Known limitations / false negatives

- The manifest is deliberately finite. A new third-party path/process API is invisible until added.
- Computed properties, reflective calls, values passed through arbitrary higher-order helpers, runtime monkey-patching, generated code, native addons, and subprocess behavior hidden inside unmanifested dependencies are not fully resolved.
- Workspace traversal uses checked-in package `source` exports and relative modules; it does not inspect external `node_modules` implementations.
- Call identity uses the nearest named function/method plus an occurrence number. Refactors can require registry updates even when authority is unchanged.
- The checker verifies declared syntactic capabilities, not path provenance, tenant scoping, authorization, cleanup correctness, TOCTOU safety, or command argument safety. Those require runtime design and negative tests at the owning boundary.
