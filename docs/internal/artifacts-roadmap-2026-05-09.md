# Artifacts Format Refactor — 2026-05-09

Single-PR refactor consolidating artifact format, env var injection, daemon capabilities, and a TOFU consent flow. Backwards compatibility intentionally **not preserved** — old artifacts get a clear upgrade prompt that points at the MCP tool surface for self-service migration.

The original branch goal (build a "deserialize artifact → folder" MCP tool) was a no-op: `agor_artifacts_land` already shipped in PR #1052. This branch was repurposed for the refactor below.

---

## Goals

1. **One canonical format.** Files map + DB metadata. No `sandpack.json` sidecar, no `dependencies` column-as-truth, no Agor-only manifest fields scattered across the file tree.
2. **Standard JS env-var idiom.** `required_env_vars` declared on the artifact; daemon injects a per-viewer `.env` at render time. Apps read `import.meta.env.VITE_*` (Vite) or `process.env.*` (other bundlers). No more Handlebars-as-JS.
3. **Explicit daemon capabilities.** `agor_grants` metadata enumerates what the daemon will inject (JWT, API URL, proxy URLs, etc.). Each grant maps to a well-known env var name. Auditable and stricter consent treatment for high-power grants.
4. **TOFU consent for non-self artifacts.** The daemon won't inject secrets or capabilities into someone else's artifact without an explicit trust grant from the viewing user.
5. **One-shot agent review** as a consent-time aide.
6. **Clean port to CodeSandbox** as a side benefit — once artifacts are standard JS projects, "Open in CodeSandbox" is trivial.

---

## What gets ripped

### 1. `use_local_bundler` everywhere

The self-hosted Sandpack bundler had two flawed versions and the original VPN-driven motivation was solved at the Chrome-config layer. Dead-end.

- Drop `use_local_bundler` field from `SandpackManifest` (`packages/core/src/types/artifact.ts:96`) and `Artifact` type.
- Drop the column from SQLite + Postgres schemas (migration: drop column).
- Drop `selfHostedBundlerURL` resolution in `ArtifactsService` (`apps/agor-daemon/src/services/artifacts.ts:113`).
- Drop the `--with-sandpack` build path's hosting plumbing (CLI flag, daemon route, UI bundler URL plumbing). Verify build script + docker still work.
- Drop the publish-time validation that rejected `use_local_bundler=true` when the bundler wasn't built (`services/artifacts.ts:265-268`).
- Drop `payload.bundlerURL` plumbing in the render path (`apps/agor-ui/src/components/SessionCanvas/canvas/ArtifactNode.tsx:467,486`). The CodeSandbox-hosted bundler is the only path.

### 2. `sandpack.json` as a serialized file format

- `readFilesRecursive` no longer special-cases `sandpack.json` (`services/artifacts.ts:1098`) — it's just a regular file if a user happens to have one, but Agor doesn't read or write it.
- `land()` no longer reconstructs a `sandpack.json` on disk (`services/artifacts.ts:616-626`).
- `publish()` no longer parses one (`services/artifacts.ts:252-262`).
- `package.json#dependencies` becomes the source of truth for runtime deps. If absent at publish time, synthesize a minimal one from the `dependencies` field on the publish call.

### 3. `agor.config.js` Handlebars rendering

- Remove the per-fetch Handlebars rendering layer (`services/artifacts.ts:46-62, 664, 897-987`).
- Anything that today relied on `{{user.env.X}}`, `{{agor.token}}`, `{{agor.apiUrl}}`, `{{agor.proxies.X.url}}`, `{{user.email}}`, `{{artifact.id}}`, `{{artifact.boardId}}` migrates to the new `required_env_vars` + `agor_grants` system below.

### 4. `dependencies` and `entry` columns as the source of truth

Keep the columns as a denormalized read cache (cheap), but `package.json` is canonical. On publish, parse `package.json` into the cache columns; on read, prefer the file-map's `package.json`.

---

## What gets added

### 1. `sandpack_config` jsonb column

A single object spread directly into `<SandpackProvider {...config} />` at render time:

```ts
sandpack_config: {
  template?: SandpackTemplate
  customSetup?: { dependencies?, devDependencies?, entry?, environment? }
  theme?: SandpackThemeProp
  options?: { activeFile?, visibleFiles?, layout?, recompileMode?,
              showConsole?, showLineNumbers?, showInlineErrors?, ... }
}
```

Shape mirrors `SandpackProviderProps` (`@codesandbox/sandpack-react`'s `types.ts`). On read, merge under defaults (`DEFAULT_SANDPACK_CONFIG`); on write, run through `sanitizeSandpackConfig` (allowlist below).

#### `sanitizeSandpackConfig` allowlist

Light. The artifact runtime is arbitrary-JS-by-design, so most "unsafe" Sandpack props don't grant new capability beyond what the file map already allows. Block only what affects the parent UI or daemon-controlled rendering:

**Allow:**
- `template`
- `customSetup.dependencies`, `customSetup.devDependencies`, `customSetup.entry`, `customSetup.environment`
- `theme`
- `options.activeFile`, `options.visibleFiles`, `options.layout`, `options.recompileMode`, `options.recompileDelay`, `options.initMode`, `options.autorun`, `options.autoReload`, `options.showNavigator`, `options.showLineNumbers`, `options.showInlineErrors`, `options.showRefreshButton`, `options.showTabs`, `options.showConsole`, `options.showConsoleButton`, `options.closableTabs`, `options.startRoute`, `options.codeEditor`

**Block (Agor-controlled or unsafe):**
- `options.bundlerURL` — Agor sets this.
- `options.externalResources` — XSS into the iframe (defense in depth, since the file map can already do this).
- `customSetup.npmRegistries` — defense in depth against confused users assuming "private registry = trusted."
- `customSetup.exportOptions` — has API token; per-user, not per-artifact.
- `teamId`, `sandboxId` — bind to a CodeSandbox account; not the artifact author's call.
- `options.fileResolver` — function-valued; can't survive JSON anyway.
- `options.classes` — applied to parent UI components. Allow only if values match a known-safe class regex (`^[a-zA-Z0-9_-]+$`), otherwise drop.

### 2. `required_env_vars` text[] column

Array of plain var names (no prefix). Examples: `["OPENAI_KEY", "GITHUB_TOKEN"]`.

At payload-fetch time, the daemon looks up the **viewing user's** encrypted `user.env.X` for each name and synthesizes a `.env` file injected into the file map on the way out (never persisted). Each bundler has its own hard-coded allowlist (CRA only inlines `REACT_APP_*`, Vite only inlines `VITE_*`, etc.), so the daemon must prefix per template:

| `SandpackTemplate` | Bundler (sandpack `environment`) | Prefix written to `.env` | App reads as | Status |
|---|---|---|---|---|
| `react`, `react-ts` | Create React App | `REACT_APP_` | `process.env.REACT_APP_X` | verified against sandpack-react v2.20.0 |
| `vue3`, `svelte`, `solid` | (inherited from #1147 — see note) | `VITE_` | `import.meta.env.VITE_X` | **not verified**; mapped as best-effort |
| `vue`, `angular` | Vue CLI / Angular CLI | none | `process.env.X` | **not verified** (Vue CLI likely wants `VUE_APP_*`) |
| `vanilla`, `vanilla-ts` | Static / Parcel | n/a (skip injection) | n/a | verified |

Prefix logic lives in a single helper: `envVarPrefixForTemplate(template: SandpackTemplate): string | null`. Templates without a working dotenv path (`vanilla`, `vanilla-ts`) skip env injection entirely; the daemon emits a warning if such an artifact has a non-empty `required_env_vars`. The lookup table is exhaustive over the `SandpackTemplate` union (`satisfies Record<…>`), so adding a new union member is a compile error until it's mapped here.

The CRA mapping is tied to `@codesandbox/sandpack-react` v2.x, which ships `react` / `react-ts` with `environment: 'create-react-app'`. If a future Sandpack version flips the built-in `react` template to a Vite-based environment, move them to `VITE_`.

The `vue3` / `svelte` / `solid` / `vue` / `angular` mappings were inherited from PR #1147 and have not been exercised end-to-end. Empirically, sandpack-react v2.20.0 maps `svelte` → `environment: 'svelte'` (Svelte 3 + Rollup, not Vite), `solid` → `environment: 'solid'`, `vue` → `environment: 'vue-cli'`, and there is no `vue3` key in `SANDBOX_TEMPLATES`. The first artifact that lands on one of those templates will likely need this audited — track as a follow-up.

### 3. `agor_grants` jsonb column

Discrete capability flags for daemon-supplied values. Each grant maps to a fixed env var name (with the template-appropriate prefix applied):

| Grant key | Env var name | Behavior |
|---|---|---|
| `agor_token: true` | `AGOR_TOKEN` | Mint a 15-min daemon JWT for the **viewer**, inject. |
| `agor_api_url: true` | `AGOR_API_URL` | Inject the daemon's base URL. |
| `agor_proxies: ["openai", "anthropic"]` | `AGOR_PROXY_OPENAI`, `AGOR_PROXY_ANTHROPIC` | Inject proxy URLs for listed vendors. |
| `agor_user_email: true` | `AGOR_USER_EMAIL` | Inject viewer's email. |
| `agor_artifact_id: true` | `AGOR_ARTIFACT_ID` | Inject this artifact's ID. |
| `agor_board_id: true` | `AGOR_BOARD_ID` | Inject the artifact's board ID. |

Conventional name + explicit declaration. Grants are part of the consent surface; consent rules below treat `agor_token` stricter than informational ones (`agor_artifact_id`, `agor_board_id`) which need no consent at all.

### 4. `artifact_trust_grants` table + TOFU consent flow

```
artifact_trust_grants
  grant_id          UUID PK
  user_id           — viewer who granted
  scope_type        — 'artifact' | 'author' | 'instance' | 'session'
  scope_value       — artifact_id | author_user_id | NULL | session_id
  env_vars_set      — JSON array of var names this grant covers
  agor_grants_set   — JSON object of grants this grant covers
  granted_at        — timestamp
  revoked_at        — timestamp (nullable; soft delete for audit)
```

**Consent resolution at render time** (in priority order):
1. Author is the viewer → no consent needed.
2. `agor_grants.agor_token` is requested → require artifact-scoped grant (never author/instance scoped — the JWT is too high-power).
3. `instance` grant covering the requested set → grant applies.
4. `author` grant covering the requested set → applies.
5. `artifact` grant covering the requested set → applies.
6. `session` grant (in-memory only) covering the requested set → applies.
7. None of the above → render iframe with **empty values** (artifact will likely error; that's fine and visible). Show "Trust to render with secrets" badge in the card header.

**Required env var or grant set is a strict subset check.** If Alice silently adds `STRIPE_KEY` to her artifact's `required_env_vars`, the existing grant doesn't cover it; re-prompt.

### 5. Consent modal

Single dialog, renders when the user clicks "Render with secrets" on a not-yet-trusted artifact.

- Reuses `FileCollection` (`apps/agor-ui/src/components/FileCollection/FileCollection.tsx`) — adapter from `Record<string, string>` files map to `FileItem[]`.
- Inline file viewer pane (no separate `CodePreviewModal` round-trip — the consent buttons must stay visible while reading code).
- Shows env vars (with ⚠ icon) and grants (with ⚠ icon, distinct color for high-power ones like `agor_token`).
- Trust scope radios: just-once, this-artifact, this-author, instance-wide. The instance option is hidden when `unix_user_mode !== 'simple'` (multi-user instances should not have a "trust everyone" button).
- Action buttons: "Render with secrets" (commits the chosen scope), "Render without" (proceed with empty values, no grant created), "Ask agent to review" (opens the review pane below).

### 6. One-shot agent review endpoint

`POST /artifacts/:id/review` → `{ summary: string, concerns: Array<{severity: 'low'|'med'|'high', file: string, line?: number, note: string}> }`

Synchronous one-shot LLM call. No DB session, no worktree, no genealogy. Uses the executor SDK plumbing already in `packages/executor/`. Hardcoded review prompt focused on: secret exfiltration patterns, suspicious `fetch()` destinations, obfuscation, unusual external resource loads.

The endpoint *informs* — it does **not** auto-grant. Concerns surface as inline badges on the file tree in the consent modal. User reads them and decides.

### 7. Settings: trusted artifacts & authors page

New section under user settings. Lists every active grant: scope, env vars covered, grants covered, granted_at, last-used. Revoke button on each. Audit-log entry on revoke. Soft-deletes (`revoked_at`) preserve history.

### 8. UI surfaces

- **Artifact card header**: badge indicating consent state — "Trusted (this artifact)", "Trusted (Alice)", "Untrusted — render without secrets to view," etc.
- **Render without secrets** is a valid, common state. The card shows a small "🔓 trust to inject secrets" affordance that opens the consent modal.
- **`required_env_vars` editor** in the artifact settings panel: chip list of var names with add/remove. Hint text reminds about the prefix-per-template convention.
- **`agor_grants` editor** in the artifact settings panel: checkboxes for each grant key, multi-select for `agor_proxies`. Author-only (other viewers can't edit).

---

## Migration: backwards-compat is not preserved; old format gets a self-service upgrade prompt

Existing artifacts will have:
- `sandpack.json` files in their `files` map (an Agor-specific sidecar that's no longer parsed).
- `dependencies` / `entry` populated in DB columns (still readable as cache).
- `agor.config.js` files with Handlebars syntax (`{{user.env.X}}`, `{{agor.token}}`).
- No `required_env_vars`, no `agor_grants`, no `sandpack_config`.

### Detection

On artifact read, run a one-time `detectLegacyFormat(artifact)` that returns:

```ts
{
  isLegacy: boolean
  signals: ('has_sandpack_json' | 'has_agor_config_js' | 'no_sandpack_config' | 'has_handlebars_token' | 'has_handlebars_user_env')[]
  detectedEnvVars: string[]      // names parsed out of {{user.env.X}}
  detectedGrants: string[]       // grant keys parsed out of {{agor.X}}
}
```

### Render behavior for legacy artifacts

Render in **safe-degraded mode**: no env vars or grants injected (the old Handlebars rendering is gone, so `{{user.env.X}}` literals will show up in the bundle if the author didn't migrate). Show a banner on the artifact card:

> ⚠ This artifact uses the old format and won't render correctly. Ask your agent to upgrade it:
> ```
> Use the agor_artifacts_get tool to read artifact <id>'s files and current
> required_env_vars. Then use agor_artifacts_publish to republish with:
>   - sandpack_config populated (template, dependencies, entry from package.json)
>   - required_env_vars: [<detected var names>]
>   - agor_grants: { <detected grants> }
>   - sandpack.json and agor.config.js removed from the file map
>   - Source files updated to read env vars via the bundler's convention instead of {{user.env.*}}: process.env.REACT_APP_* for CRA-backed react/react-ts, import.meta.env.VITE_* for Vite-backed templates
> See agor_search_tools for full schemas.
> ```

The instruction text is generated dynamically from `detectLegacyFormat()` output — it interpolates the actual detected vars and grants for that specific artifact.

Rationale: MCP tools are self-documenting. The upgrade is mechanical enough for an agent to do correctly given the tool descriptions. We don't need to ship migration code that we'll delete in a month.

### Schema migration

Drizzle migration:
- ADD `sandpack_config jsonb DEFAULT '{}'`
- ADD `required_env_vars jsonb DEFAULT '[]'`  (use jsonb on Postgres, text on SQLite)
- ADD `agor_grants jsonb DEFAULT '{}'`
- DROP `use_local_bundler`
- KEEP `dependencies` and `entry` columns (denormalized cache)
- CREATE TABLE `artifact_trust_grants`

Data backfill: not attempted. Old rows get default empty values for new fields. Render path detects + warns.

---

## "Open in CodeSandbox" — bonus tool

Trivial after the refactor. New MCP tool:

```
agor_artifacts_export_codesandbox(artifactId)
  → { url: string, sandboxId: string }
```

Implementation:
1. Fetch artifact files map.
2. Strip leading slash from keys, wrap each value in `{ content }`.
3. Drop `agor.config.js` if present (will be Handlebars literals, broken on CodeSandbox).
4. POST to `https://codesandbox.io/api/v1/sandboxes/define?json=1` with `{ files, template: artifact.sandpack_config.template }`.
5. Return sandbox URL and instructions to set `required_env_vars` / `agor_grants` values via CodeSandbox's Secret Keys UI (the names will already match because the export uses the same prefix-per-template convention).

A small caveat in the tool description: `AGOR_TOKEN` and other daemon capabilities won't work on CodeSandbox — that artifact's daemon-dependent features will fail there. This is acceptable; the eject button is for share/demo, not full equivalence.

UI: parallel "Open in CodeSandbox" button on the artifact card.

---

## Future, not in this PR

- **Ephemeral sessions** (sessions not bound to a worktree). The artifact review endpoint is synchronous one-shot for now. When ephemeral sessions land, the same button can upgrade to a real session-backed flow without UI churn. Likely implementation: scratch worktree per user (option 3 from the conversation).
- **`preset-io/agor-artifact-examples` repo.** Curated examples consumable via `git clone + agor_artifacts_publish`. Empty repo + seed examples + PR template + CI to validate. Optional `agor_artifacts_publish_from_examples_repo` helper later.
- **Static MCP tool reference page on agor.live.** The artifact tools (and others) live only in code; a guide page would help human discoverability when the examples repo lands.
- **Per-env-var consent granularity.** Today's design groups all env vars in a grant. Could split if friction proves real.
- **StackBlitz export.** Browser-only SDK; UI button only, no MCP tool.

---

## Test plan (high-level)

- **Round-trip**: publish → land → publish (modified) → land. Diff matches except for explicit edits.
- **Migration**: legacy artifact (with `sandpack.json` + `agor.config.js`) renders in safe-degraded mode, banner appears with correct interpolated upgrade instructions.
- **Sanitize**: blocked Sandpack props are stripped on publish (`bundlerURL`, `externalResources`, `npmRegistries`, `teamId`, etc.).
- **Env injection**: per-template prefix is applied correctly (Vite → `VITE_`, CRA → `REACT_APP_`, etc.). Empty values injected when no consent.
- **Consent**: artifact requires `OPENAI_KEY` + `agor_token`; first render shows modal; granting "this author" persists; second render of same author's artifact requesting same set is silent; second render with new `STRIPE_KEY` re-prompts. Revocation removes grant; next render re-prompts.
- **`agor_token` is artifact-scoped only**: granting "this author" doesn't auto-cover JWT; re-prompt for it.
- **Strict subset on grant matching**: existing grant for `[OPENAI_KEY]` doesn't cover artifact requesting `[OPENAI_KEY, STRIPE_KEY]`.
- **CodeSandbox export**: round-trips a simple React artifact; sandbox URL is reachable; deps install; app builds.
- **Review endpoint**: returns concerns for an obviously malicious artifact (literal `fetch(EXFIL, body=KEY)`); returns empty concerns for a benign one.

---

## File-level scope (rough)

**Schema + types:**
- `packages/core/src/db/schema.{sqlite,postgres}.ts` — column changes + `artifact_trust_grants` table
- `packages/core/src/db/migrations/` — new migration
- `packages/core/src/types/artifact.ts` — drop `SandpackManifest`, add `SandpackConfig`, `AgorGrants`, `ArtifactTrustGrant`
- `packages/core/src/db/repositories/artifact.ts` — new fields
- `packages/core/src/db/repositories/artifact-trust.ts` — new repo

**Daemon:**
- `apps/agor-daemon/src/services/artifacts.ts` — rip `agor.config.js` rendering, rip `sandpack.json` handling, rip `use_local_bundler`, add `.env` synthesis with prefix logic, add `agor_grants` injection, add legacy detection
- `apps/agor-daemon/src/services/artifact-trust.ts` — new service for grants
- `apps/agor-daemon/src/mcp/tools/artifacts.ts` — update `publish` + `get` schemas, add `export_codesandbox`, add `review` (or expose via REST)
- `apps/agor-daemon/src/services/artifact-review.ts` — new one-shot review endpoint
- `apps/agor-daemon/src/utils/sandpack-config.ts` — `sanitizeSandpackConfig`, `envVarPrefixForTemplate`, defaults

**UI:**
- `apps/agor-ui/src/components/SessionCanvas/canvas/ArtifactNode.tsx` — render path uses `sandpack_config` blob, drops `bundlerURL`, shows trust state badge
- `apps/agor-ui/src/components/ArtifactConsentModal/` — new component (single modal w/ inline file viewer, reuses `FileCollection`)
- `apps/agor-ui/src/components/SettingsModal/TrustedArtifactsTab.tsx` — new settings tab
- `apps/agor-ui/src/components/SettingsModal/ArtifactsTable.tsx` — add `required_env_vars` / `agor_grants` editors
- Storybook stories for the consent modal

**Docs:**
- `apps/agor-docs/pages/guide/artifacts.mdx` — rewrite for new format
- `CLAUDE.md` — update artifact section
- `context/concepts/` — possibly a new `artifacts.md`

---

## Notes for the implementing agent

- The user runs `pnpm dev` in watch mode; do **not** run `pnpm build`.
- Use `simple-git` for any git ops, never `execSync`.
- Pre-commit hooks (typecheck, lint) must pass; do not use `--no-verify`.
- `agor_artifacts_land` already exists and stays. Round-trip via land → edit → publish should still work post-refactor, just with the new format.
- This is intentionally not split into multiple PRs. The pieces are interlocking enough that a half-shipped state would be worse than the full refactor.
