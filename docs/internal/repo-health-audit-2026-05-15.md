# Agor Repo Health Audit — 2026-05-15

> **Status:** Audit + ~11 of 15 quick wins landed in PR #1199 (this branch).
> Remaining quick wins, medium efforts, and deep investigations are still
> the punch list below — implementation worktrees still spawn after review.

## TL;DR

**Overall rating: B**.

The codebase is **unusually disciplined for ~226 k LOC across 8 workspaces** — canonical types live in one place, no upward layering violations, MCP/Feathers/CLI surfaces are uniform, almost no commented-out code, zero `debugger` statements, zero `.only` tests, and the recent consolidation work (PR #1143 git-impersonation, single toast hook, `resolveApiKey`, `resolveSessionDefaults`) is sticking. The drift is real but localized.

**Top three quick wins** (each shippable in ≤2 h):

1. Wire `lint-staged` into `.husky/pre-commit` — the `.lintstagedrc.json` exists but is never invoked, so every commit triggers a full-repo Turbo typecheck+lint. Biggest single dev-loop fix in the repo.
2. Drop `apps/agor-daemon/src/services/context.ts` (fully `@deprecated`, "use file service") + the three stacked deprecated aliases at `apps/agor-daemon/src/utils/spawn-executor.ts:571,576,590`.
3. Strip the `🔐 Authentication attempt:` payload-dump `console.log` at `apps/agor-daemon/src/register-routes.ts:353` — security + cleanup two-for-one (may be leaking auth payload contents to stdout).

**Top three medium efforts** (each warrants a dedicated worktree):

1. **Codemod `console.log` → `logger`** across the ~10 worst offenders (`unix-integration-service.ts:64`, `oauth-mcp-transport.ts:64`, `register-routes.ts:57`, …). ~400+ call sites collapse into the existing `packages/core/src/utils/logger.ts`. One off-switch for noisy modules.
2. **Remove `// @ts-nocheck` from `apps/agor-ui/src/hooks/useAgorData.ts`** (1 244 LOC of WebSocket event handling currently un-typed). Worst hot-spot in the UI by blast-radius — replaces an `as any` bucket with proper event-payload types from `@agor-live/client`. Also split by entity domain.
3. **Carve the three daemon mega-files** (`register-routes.ts` 3 298 LOC, `register-services.ts` 2 594 LOC, `register-hooks.ts` 2 335 LOC) into `setup/{routes,services,hooks}/<service-group>.ts`. They already have section banners marking the seams; the next factoring is mechanical.

**Top three deep investigations** (design before code):

1. **RBAC seam unification** — three permission paths (`authorization.ts` role gating, `worktree-authorization.ts` 1 569-LOC kitchen sink, `PermissionService` in core, plus inline `isVisibleTo` checks). Decide on one intent-based entry (`requireAccess({ resource, action, params })`) before adding more checks.
2. **`packages/core` browser surface** — root `index.ts` is a 12-way `export *` barrel that drags `bcryptjs`, `drizzle-orm`, `unix/*`, `simple-git`, and `feathers` into the import graph. Subpath exports already exist; consumers need to be migrated and a `sideEffects: false` policy committed.
3. **Onboarding consolidation** — three "quickstarts" (README's `npm i -g agor-live`, CONTRIBUTING's `docker compose up`, AGENTS.md's `pnpm dev` in two terminals) and the fastest dev loop is buried in agent-only docs. Pick one local-dev path, fold AGENTS.md's troubleshooting into CONTRIBUTING.md, and delete the rest.

---

## Per-dimension ratings

| Dimension               | Rating | Headline finding                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dead code**           | **B-** | knip reports 190 unused exports + ~22 real orphan files after FP filtering; modest unused deps (`@webscopeio/react-textarea-autocomplete`, `@iarna/toml` × 2). Knip's vitest configs all fail to load, masking the test surface — config gap to fix first.                                                                                               |
| **Refactor**            | **B-** | Three god-files in the daemon (~8.2 k LOC combined). `useAgorData.ts:1` carries `@ts-nocheck` over 1 244 LOC. `artifacts.ts` mixes five concerns in one 1 903-LOC service. `parseTruncationLength` copy/pasted byte-for-byte across two services.                                                                                                        |
| **DevEx**               | **B**  | Solid baseline (Biome, Turbo, Vitest, Husky, knip, dependabot, multi-workflow CI). Held back by: pre-commit ignores `.lintstagedrc.json`, CONTRIBUTING.md is a stale redirect, CI skips executor (25 tests) and CLI (2 tests).                                                                                                                           |
| **Cleanup**             | **B+** | Zero `.bak/.old/.swp/.DS_Store`, zero `debugger`, zero `.only`. The only `.skip` is a legit env gate. 48 TODOs / 30 files. 17 `@deprecated` API surfaces still exported. ~1 259 `console.log` across 114 files is the one real lever.                                                                                                                    |
| **Architectural drift** | **B+** | Canonical types, single toast hook (`useThemedMessage`), uniform `DrizzleService<T,…>` shape across 13 services, uniform `textResult(...)` MCP returns (112 sites). One mega-routes file is the only RPC choke point.                                                                                                                                    |
| **Bundle / build perf** | **C+** | UI `vite.config.ts` has no `manualChunks`, no `chunkSizeWarningLimit`. Five heavy single-use deps (sandpack, tsparticles, emoji-picker, codemirror, react-syntax-highlighter) never lazy-loaded. `@agor/core` root barrel pulls Node-only modules into any consumer that doesn't use the subpath exports. Two `require()` calls survive in ESM TS files. |

---

## Quick wins (ship in 1-2 h each)

**Status legend:** ✅ shipped in PR #1199 · ⚪ deferred (see notes).

| #     | Status     | Title                                                                                                                                                                                                                                                                                                                            | Touches                                     | Source dimension |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------- |
| QW-1  | ✅         | **Wire `lint-staged` into Husky** — replace `pnpm typecheck && pnpm lint` in `.husky/pre-commit` with `pnpm exec lint-staged`; the `.lintstagedrc.json` is already correct.                                                                                                                                                      | `.husky/pre-commit`, `package.json` scripts | DevEx            |
| QW-2  | ⚪ partial | **Drop deprecated services & aliases** — delete `apps/agor-daemon/src/services/context.ts` (whole file `@deprecated`, use `file` service); remove 3 stacked deprecated aliases at `apps/agor-daemon/src/utils/spawn-executor.ts:571,576,590`; remove 5 deprecated `worktree.ts` types (`types/worktree.ts:592,779,807,824,840`). | daemon + core                               | Cleanup          |
| QW-3  | ✅         | **Strip auth-payload log** — `apps/agor-daemon/src/register-routes.ts:353` logs `🔐 Authentication attempt:` with the full payload. Security + cleanup.                                                                                                                                                                          | daemon                                      | Cleanup          |
| QW-4  | ✅         | **Drop unused npm deps** — `@webscopeio/react-textarea-autocomplete` (+ its `.d.ts`) in `apps/agor-ui`; `@iarna/toml` in `packages/{core,executor,agor-live}`; verify `@theguild/remark-mermaid` + `katex` in `apps/agor-docs`.                                                                                                  | various package.jsons                       | Dead code        |
| QW-5  | ✅         | **Delete duplicate type defs** — `apps/agor-cli/src/commands/{session,repo}/list.ts:15` both redefine `Paginated<T>`; replace with `PaginatedResult<T>` from `@agor/core`. Rename `SessionsService` interface in `packages/executor/src/sdk-handlers/claude/claude-tool.ts:146` so it stops shadowing the canonical type.        | cli + executor                              | Architecture     |
| QW-6  | ✅         | **Lift `parseTruncationLength`** — verbatim 22-line copy at `apps/agor-daemon/src/services/sessions.ts:102` and `apps/agor-daemon/src/services/worktrees.ts:58`. Move to `apps/agor-daemon/src/utils/parse-pagination.ts`.                                                                                                       | daemon                                      | Refactor         |
| QW-7  | ⚪         | **Enable executor + CLI tests in CI** — `.github/workflows/ci.yml` currently filters to `--filter=agor-ui --filter=@agor/daemon --filter=@agor/core`, leaving 25 executor tests + 2 CLI tests un-gated on PRs. Drop the filter.                                                                                                  | CI config                                   | DevEx            |
| QW-8  | ✅         | **Add basic Vite `manualChunks`** — `apps/agor-ui/vite.config.ts` has no chunking. Add a starter map (antd / reactflow / editor / syntax / emoji / particles / xterm) plus `chunkSizeWarningLimit: 1000`.                                                                                                                        | UI vite config                              | Build perf       |
| QW-9  | ✅         | **Fix CONTRIBUTING.md stale tooling reference** — line 62 says "ESLint + Prettier"; repo runs Biome. Plus `apps/agor-docs/pages/guide/development.mdx:108` mentions `eslint-linux`.                                                                                                                                              | docs                                        | DevEx            |
| QW-10 | ⚪         | **Resolve 4 aged "Phase 1" board TODOs** — `boards.ts:567`, `worktrees.ts:886`, `worktrees.ts:917`, `repo-list.ts:171`. Either implement or delete the comment if the migration completed.                                                                                                                                       | daemon                                      | Cleanup          |
| QW-11 | ✅         | **Add `.editorconfig`** — multi-language repo (TS, MDX, YAML, Dockerfile, shell) has none; Biome only covers JS/TS.                                                                                                                                                                                                              | root                                        | DevEx            |
| QW-12 | ✅         | **Pin `.nvmrc` to a patch** — currently `22` (major-pinned); pin to `22.12.0` to match `engines.node`.                                                                                                                                                                                                                           | root                                        | DevEx            |
| QW-13 | ✅         | **Replace 2 stray `require()` in ESM** — `apps/agor-cli/src/commands/daemon/start.ts:194-195` and `packages/core/src/db/repositories/board-objects.test.ts:924`.                                                                                                                                                                 | cli + core                                  | Build perf       |
| QW-14 | ⚪         | **Split `Pill.tsx`** — `apps/agor-ui/src/components/Pill/Pill.tsx` is 1 107 LOC with 21 named pill exports. Mechanical split per pill into `Pill/<Name>Pill.tsx`.                                                                                                                                                                | UI                                          | Refactor         |
| QW-15 | ✅         | **Add `scripts/` to knip entry config** — currently flagged as orphan files (false positive).                                                                                                                                                                                                                                    | `knip.json`                                 | Dead code        |

### Notes on deferred quick wins

- **QW-2 (partial)** — `services/context.ts` is still registered at `register-services.ts:386`; deletion requires also un-mounting `/context` and migrating any callers to `file`. Worth a small follow-up worktree. The deprecated **aliases** in `spawn-executor.ts` are partially landed: `SpawnExecutorResult` and `FireAndForgetOptions` removed (zero callers); `spawnExecutorFireAndForget` kept because ~10 active call sites depend on it (audit assumed it was dead — it isn't). The 5 deprecated `worktree.ts` types still need a caller sweep.
- **QW-7** — needs the executor + CLI test suites to actually pass on CI infra first; would land red. Not bundled here to keep the audit-cleanup PR green.
- **QW-10** — each aged TODO needs domain context to either implement or delete cleanly. Defer to per-feature worktrees rather than blind comment removal.
- **QW-14** — explicit structural change to a 21-export file; defer per repo policy of not auto-restructuring large UI files inside a chore PR.

---

## Medium efforts (worth a dedicated worktree)

| #    | Title                                                                                                                                           | Why it's medium                                                                                                                                                                                                                                                                                                                             | Sources         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| M-1  | **`console.log` → `logger` codemod** across the top-10 offenders                                                                                | ~400+ call sites; needs convention for `[scope]` prefixes → `logger.child({ scope })`. Existing logger at `packages/core/src/utils/logger.ts`.                                                                                                                                                                                              | Cleanup         |
| M-2  | **Remove `@ts-nocheck` from `useAgorData.ts`**                                                                                                  | 1 244 LOC of WebSocket handling; needs narrow event-payload types per channel from `@agor-live/client`. Split by entity domain (sessions/worktrees/boards) while doing it.                                                                                                                                                                  | Refactor        |
| M-3  | **Carve the `register-*.ts` mega-files**                                                                                                        | 3 298 + 2 594 + 2 335 LOC → `setup/{routes,services,hooks}/<service-group>.ts`. Section banners already mark the seams. Also extract a `registerCustomMethod(app, path, method, handler, opts)` helper to kill the duplicated emit/log/error scaffolding.                                                                                   | Refactor + Arch |
| M-4  | **Decompose `artifacts.ts`** (1 903 LOC, 5 concerns)                                                                                            | Service CRUD stays; pull `ArtifactPayloadBuilder`, `ArtifactPublisher`, `ArtifactLander`, `ArtifactTrustResolver`, `ArtifactConsoleBuffer` into siblings. Methods `patch` (245 LOC) and `updateMetadata` (141 LOC) share placement-move logic — extract `moveArtifactPlacement()`.                                                          | Refactor        |
| M-5  | **Fix knip's vitest config loading + add CI gate**                                                                                              | All vitest configs fail to load (`Cannot find module 'vitest/config'`), so knip marks 179 test files as orphans. Fix the config; then snapshot current findings and gate "new orphans" in CI. Drop `ts-prune` and `unimported` from any future tooling list.                                                                                | Dead code       |
| M-6  | **Carve `worktree-authorization.ts`** (1 569 LOC) into `permissions.ts` / `find-scoping.ts` / `spawn-identity.ts` / `unix-username-resolver.ts` | Test files already have these names — the boundaries are conceptual; make them real in src.                                                                                                                                                                                                                                                 | Arch            |
| M-7  | **Lazy-load heavy single-use UI deps**                                                                                                          | Wrap with `React.lazy(() => import(...))`: `ParticleBackground` (`@tsparticles/*`, login-only), `EmojiPicker` (`emoji-picker-react` + `emojibase`/`emojibase-data` — likely de-dup one), sandpack preview, codemirror editors. None are currently dynamic-imported.                                                                         | Build perf      |
| M-8  | **Add `sideEffects: false` to `packages/core`** + audit UI's import graph for accidental root-barrel hits                                       | `packages/core/src/index.ts` is `export *` × 12; same for `db/index.ts` and `types/index.ts`. A small refactor of `db/index.ts:22-24` (the bcryptjs re-export) plus `sideEffects: false` would unblock real tree-shaking. Use `madge --circular` or `dpdm` to confirm no UI file imports `@agor/core` (root) instead of `@agor/core/types`. | Build perf      |
| M-9  | **Promote `AGENTS.md` → `CONTRIBUTING.md`** (or fold troubleshooting + dev-loop sections into CONTRIBUTING.md)                                  | Three onboarding entry points → one. AGENTS.md is already the most useful dev doc — name it accordingly. Move `PLAN.md` (single-feature design doc) out of repo root.                                                                                                                                                                       | DevEx           |
| M-10 | **Audit `packages/client` published surface**                                                                                                   | depcheck flags ALL `@feathersjs/*` + `socket.io-client` as unused — but this _is_ the public client package. Either deps are vestigial or the package isn't actually using them at runtime. Users will hit whatever is wrong.                                                                                                               | Dead code       |
| M-11 | **`@deprecated` API sweep**                                                                                                                     | 17 surfaces still exported. One PR per package (`types/`, `db/repositories/`, executor SDK handlers) removing them + internal callers.                                                                                                                                                                                                      | Cleanup         |
| M-12 | **UI test backlog**                                                                                                                             | 11 tests for the entire React app despite Storybook + addon-vitest installed. Auto-generate render smoke tests by pairing Storybook stories with `addon-vitest`.                                                                                                                                                                            | DevEx           |

---

## Deep investigations (design before action)

| #   | Topic                                              | Why it's "design-first"                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | **Unified RBAC entry point**                       | Three permission paths (`authorization.ts` role, `worktree-authorization.ts` worktree-scoped RBAC, `PermissionService` in core) plus inline `isVisibleTo` checks in `services/artifacts.ts:344,586`. Pre-design what an intent-based `requireAccess({ resource, action, params })` looks like; otherwise refactor goes in circles. |
| D-2 | **`@agor/core` browser-safe surface**              | Root barrel hides Node-only modules (`bcryptjs`, `drizzle-orm`, `unix/*`, `simple-git`, `feathers`). Subpath exports already exist in `package.json`. Needs a written contract: "UI imports `@agor/core/types`, `@agor/core/client`, `@agor/core/config/browser`; never the root." Then a one-shot migration + lint rule.          |
| D-3 | **`register-routes.ts` future**                    | Today every custom RPC (fork/spawn/btw/genealogy/prompt) appends here; emit + log + auth-check are duplicated per-route. Decide: keep central registry pattern (extract helper) vs. let services self-register their custom methods. Affects every future RPC.                                                                     |
| D-4 | **`dangerously_allow_session_sharing` flag**       | Defaults OFF, 27 ref sites + dedicated tests. Per user policy (`feedback_security_posture.md`: gate-don't-remove), probably stays — but worth an explicit decision so the legacy path doesn't accrete more code by accident.                                                                                                       |
| D-5 | **Onboarding canonical path**                      | Three competing quickstarts; the recurring AGENTS.md troubleshooting entries ("Method is not a function after editing @agor/core", `rm -rf node_modules/.tsx`) are symptoms of a tsup + tsx watch interaction that hasn't been root-caused. Solve that once = remove the troubleshooting section entirely.                         |
| D-6 | **Executor `claude/` sub-dir orphans**             | knip flags `index.ts`, `session-context.ts`, `safe-message-service.ts`, `import/task-extractor.ts` as unused. May be in-progress refactor cruft — needs executor-owner confirmation before deletion.                                                                                                                               |
| D-7 | **CSS / styling consistency** (not deeply audited) | UI ships antd 6, with both CSS-in-JS theming and reactflow's own stylesheet; bundle-perf flagged no double-theme load but didn't verify. Worth a one-page design pass before any big visual refactor.                                                                                                                              |

---

## Tooling recommendations

**Adopt:**

- ✅ **`knip`** as a recurring check (already installed; `knip.json` exists). First fix the vitest-config loading errors (it's hiding 179 test files in the false-positive bucket), then add `scripts/**/*.{ts,mjs}` to entries, snapshot current findings, and gate **new** orphans in CI via `pnpm dlx knip --reporter compact`.
- ✅ **`lint-staged`** — config already in `.lintstagedrc.json`; just wire it into `.husky/pre-commit`. Biggest single dev-loop fix in the repo (10 min PR).
- ✅ **`.editorconfig`** + `.tool-versions` (or pin `.nvmrc` to a patch) — small upfront, kills entire categories of indentation/format drift.
- ✅ **CODEOWNERS** + `.github/PULL_REQUEST_TEMPLATE.md` — currently absent.

**Drop / don't bother:**

- ❌ **`ts-prune`** — too noisy for monorepos with oclif command-by-convention and MCP string-loading (1 329 "unused" exports in `packages/core` alone, almost all false positives). knip is a superset.
- ❌ **`unimported`** — failed to detect entry points; depcheck already covers its niche.

**Worth trying:**

- 🔍 **`madge --circular`** or **`dpdm`** for a one-shot import-graph audit (browser-surface investigation, D-2).
- 🔍 **`pnpm dedupe --check`** for the dual-versioned `zod@3` / `esbuild@0.25.{4,12}` transitives.
- 🔍 **`rollup-plugin-visualizer`** behind a one-off `pnpm build` to confirm chunk sizes after QW-8.

---

## Methodology

**Coordinator + 5-subagent pattern.** This audit was produced by a coordinator session (this one) running the dead-code tooling sweep directly, while spawning 5 parallel `general-purpose` Claude Code subagents for the analytical dimensions (refactor, devex, cleanup, architectural drift, build perf). Each subagent received an independent brief, read the repo fresh (no shared context with the coordinator), and wrote findings to `/tmp/repo-audit-<dimension>.md`. The coordinator aggregated.

Runtime: ~5 min wall-clock for tooling + parallel analysis vs. an estimated ~30+ min sequential.

**Tools run per dimension:**

- **Dead code** — `knip 5.85` (primary, workspace-aware), `depcheck` per-workspace (confirmation), `ts-prune` (noisy, retired), `unimported` (failed to run).
- **All other dimensions** — `Grep`/`Glob`/`Read` static analysis only. No builds run (user is on watch mode).

**What was NOT audited (and why):**

- **Actual bundle byte sizes** — would require `pnpm build`; user runs watch mode and the brief said not to interfere. Recommended as a one-off follow-up under QW-8.
- **Test reliability under flake** — would require running the test suite repeatedly; out of scope for a static audit.
- **`apps/agor-docs` (Nextra/Next.js) bundle** — lower-priority surface, not deep-audited.
- **Runtime perf / latency** — separate dimension; ask if you want a perf audit run next.
- **Security review** — already covered separately (see `feedback_security_posture.md` policy and the standing private review).

**Per-dimension findings live in** `/tmp/repo-audit-{deadcode,refactor,devex,cleanup,architecture,buildperf}.md` (this audit's source material; not committed). Re-runnable via the coordinator pattern.

---

## Source files for follow-up worktrees

Suggested worktree-per-medium-effort mapping (Max's call which actually spin up):

- `cleanup-console-log-codemod` → M-1
- `ui-typecheck-useAgorData` → M-2
- `daemon-routes-services-hooks-split` → M-3
- `daemon-artifacts-decompose` → M-4
- `tooling-knip-ci-gate` → M-5
- `daemon-rbac-carve` → M-6
- `ui-lazy-heavy-deps` → M-7
- `core-browser-tree-shaking` → M-8
- `docs-onboarding-unification` → M-9

The 15 quick wins can ride in one bundled `cleanup-quick-wins-2026-05-15` worktree or be split if reviewers prefer narrow diffs.
