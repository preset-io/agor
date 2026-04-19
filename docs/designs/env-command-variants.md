# Env command variants & override layering — design analysis

**Status:** Draft for review — no code changes yet
**Branch:** `analyze-env-command-variants`
**Owner:** env-commands / managed-environments area

---

## 1. Current architecture (what we have today)

Env commands flow through three storage layers that render and cascade into one another:

1. **Repo template** (`repo.environment_config: RepoEnvironmentConfig`) — a single set of Handlebars-templated commands stored in the DB per repo. Fields: `up_command`, `down_command`, `nuke_command`, `health_check.url_template`, `app_url_template`, `logs_command`. Admin-only edit. See `packages/core/src/types/worktree.ts:590-657`.

2. **Worktree render** (`worktree.start_command`, `stop_command`, `nuke_command`, `health_check_url`, `app_url`, `logs_command`) — the **rendered** output of the repo template at worktree creation time. Stored as plain strings; the template is evaluated once with a context built in `packages/core/src/templates/handlebars-helpers.ts:233` (`worktree.*`, `repo.*`, `host.ip_address`, `custom.*`). UI can "Regenerate from Template" (`EnvironmentTab.tsx:296`) or edit these fields directly in place.

3. **`.agor.yml`** — optional file at the repo root that mirrors `RepoEnvironmentConfig` in flat form. Two admin-gated actions: `POST /repos/:id/import-agor-yml` overwrites `repo.environment_config` wholesale (`repos.ts:783`); `POST /repos/:id/export-agor-yml` writes the current in-DB config to the file. Parser in `packages/core/src/config/agor-yml.ts`.

A narrow escape-hatch for deployment-local values already exists: `config.daemon.host_ip_address` (set in `~/.agor/config.yaml`) flows into `host.ip_address` in the template context.

**Known pain points:** one template set per repo (no `lean` vs `postgres`); import silently wipes local edits; worktree-level direct edits drift silently from the repo template; deployment-local values have nowhere to live except global config or per-worktree edits.

---

## 2. Proposed data model

### 2a. `.agor.yml` v2 — shared, committed to git

```yaml
# .agor.yml — repo-shared; exported/imported verbatim
version: 2

environment:
  default: lean                    # which variant new worktrees get by default
  variants:
    lean:
      description: "SQLite-backed, single-container, fast iteration"
      start: "docker compose -f docker-compose-light.yml -p agor-{{worktree.name}} up -d"
      stop:  "docker compose -f docker-compose-light.yml -p agor-{{worktree.name}} down"
      nuke:  "docker compose -f docker-compose-light.yml -p agor-{{worktree.name}} down -v"
      logs:  "docker compose -f docker-compose-light.yml -p agor-{{worktree.name}} logs --tail=100"
      health: "http://{{host.ip_address}}:{{add 9000 worktree.unique_id}}/health"
      app:    "http://{{host.ip_address}}:{{add 5000 worktree.unique_id}}"

    postgres:
      description: "Postgres + Redis + Celery — closer to prod"
      extends: lean              # single-level only; see rules below
      # Only the fields that differ from lean:
      start: "docker compose -p agor-{{worktree.name}} up -d --build"
      stop:  "docker compose -p agor-{{worktree.name}} down"
      nuke:  "docker compose -p agor-{{worktree.name}} down -v"
      logs:  "docker compose -p agor-{{worktree.name}} logs --tail=100"

    full:
      description: "Postgres + Redis + Celery + worker + beat"
      extends: lean              # NOT `extends: postgres` — see rules
      start: "COMPOSE_PROFILES=full docker compose -p agor-{{worktree.name}} up -d --build"
      stop:  "docker compose -p agor-{{worktree.name}} down"
      nuke:  "docker compose -p agor-{{worktree.name}} down -v"
      logs:  "docker compose -p agor-{{worktree.name}} logs --tail=100"
```

**`extends` is single-level only.** A variant may extend a **base** variant (one that has no `extends` key of its own). A variant that itself extends something else cannot be extended. This rules out chains like `full → postgres → lean` while keeping the common case — "same as `lean` but with a different `start`" — ergonomic. Parser rejects chains deeper than one level at save time with a clear error (`"variant 'full' extends 'postgres', which itself extends 'lean' — chains deeper than one level are not allowed"`). Resolution is a simple per-field merge: child fields override base fields; fields the child omits are inherited.

### 2b. Repo-level `template_overrides` — DB-only, never exported

Stored in DB alongside the variants, **not** written to `.agor.yml`, **not** in the export payload. This is where deployment-local template-var values live (the generalization of today's `daemon.host_ip_address`):

```yaml
# Represented in DB as repo.environment.template_overrides (JSON);
# shown/edited in the admin UI but stripped from import/export.
template_overrides:
  host:
    ip_address: "10.0.1.42"       # overrides daemon config / autodetect
  custom:
    internal_registry: "registry.preset.io"
    aws_profile: "preset-dev"
```

At render time, `template_overrides` is **deep-merged into the Handlebars context** after the defaults (daemon config, autodetect) but before `custom.*` values from the worktree. So Preset can import Superset's clean upstream `.agor.yml` and set their host IP / registry values per-repo without a global config file, and without risk of leaking values back to the shared file.

> **⚠ Not for secrets.** `template_overrides` is visible to all users with repo access (admins can edit; members can read). Use it for infra identifiers — IPs, registries, profile names — not for API keys or tokens. Secrets belong in the session env-var system (per-session scope selection from PR #1032), never in template values that end up baked into shell strings.

### 2c. Worktree — pure rendered snapshot

```ts
// packages/core/src/types/worktree.ts
export interface Worktree {
  // ...existing fields...
  environment_variant?: string;   // e.g. "lean" | "postgres" | "full"

  // Existing rendered-command fields stay as they are — they ARE the snapshot:
  // start_command, stop_command, nuke_command,
  // health_check_url, app_url, logs_command
}
```

The worktree stores the **fully rendered** commands as flat strings. No templating, no sparse overrides, no layering at read time. Edits to the worktree commands are manual string edits; "Render" is the button that regenerates from variant + template_overrides, discarding manual edits (with a confirm when dirty). Worktrees are typically short-lived, so ossified snapshots are fine.

---

## 3. Override layering model

Three layers, precedence **low → high**:

```
  repo variant (.agor.yml or repo.environment.variants[name])
        └─► repo template_overrides (DB-only, per-repo)
                  └─► worktree rendered snapshot (user-edited strings)
```

**Layer 1 — repo variant:** authored by repo maintainers. Committed in `.agor.yml`. Exportable.

**Layer 2 — repo `template_overrides`:** per-Agor-deployment, per-repo. Lives in DB. Admin-only in the UI. Never in `.agor.yml`. Provides concrete values for template vars (`host.*`, `custom.*`) so the shared variants can reference them without hard-coding. Replaces the need for most `~/.agor/config.yaml` entries; the global config remains as a fallback (so autodetected `host.ip_address` still works for repos without overrides).

**Layer 3 — worktree snapshot:** created by rendering `variant + template_overrides` at worktree-create time (or on explicit "Render"). User edits the rendered YAML directly. No link to the template after that — re-render to refresh.

### Rendering algorithm
Computing the snapshot for a worktree:

```
1. variant = repo.environment.variants[worktree.environment_variant ?? default]
2. context = {
     ...daemonDefaults,                 // host.ip_address autodetect, etc.
     ...deepMerge(repo.template_overrides),  // repo DB-only overrides win
     worktree: { unique_id, name, path, gid },
     repo:     { slug },
     custom:   worktree.custom_context,
   }
3. For each of the 6 commands in variant: Handlebars-render with context.
4. Write results to worktree.start_command, stop_command, ...
```

After step 4, the snapshot is independent — editing `repo.template_overrides` or the variant does nothing until the user hits Render again.

---

## 4. UI proposal — two YAML editors, read/edit exclusivity

Replace the current form-based Environment tab with two stacked YAML editors. Only one is editable at a time.

### Layout

```
┌─ Environment — feat/new-filter ───────────────────────────────┐
│  [ Start ] [ Stop ] [ Restart ] [ Nuke ] [ Logs ]              │
│                                                                │
│  ┌─ Repository environment (shared) ──────────────── [Edit] ─┐│
│  │ version: 2                                                ││
│  │ environment:                                              ││
│  │   default: lean                                           ││
│  │   variants:                                               ││
│  │     lean: { start: "...", stop: "...", ... }              ││
│  │     postgres: { ... }                                     ││
│  │ template_overrides:        # 🏠 deployment-local         ││
│  │   host: { ip_address: "10.0.1.42" }                       ││
│  │                                                           ││
│  │ [Import .agor.yml] [Export .agor.yml]  📖 Docs            ││
│  └───────────────────────────────────────────────────────────┘│
│                                                                │
│  Variant: [ postgres ▾ ]  [ Render ▸ ]                         │
│                                                                │
│  ┌─ Worktree environment (this worktree) ──────────── [Edit] ┐│
│  │ # Rendered from variant: postgres                         ││
│  │ start: "docker compose -p agor-feat-new-filter up -d …"   ││
│  │ stop:  "docker compose -p agor-feat-new-filter down"      ││
│  │ nuke:  "docker compose -p agor-feat-new-filter down -v"   ││
│  │ logs:  "docker compose -p agor-feat-new-filter logs …"    ││
│  │ health: "http://10.0.1.42:9003/health"                    ││
│  │ app:   "http://10.0.1.42:5003"                            ││
│  └───────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────┘
```

### Interaction rules

- **Read/edit exclusivity:** starting edit on one editor disables the `[Edit]` button on the other until the user saves or cancels. Prevents cross-level confusion and avoids a second modal.
- **Top editor (repo):** **admin-only to edit; readable by everyone** with repo access. YAML of `version`, `environment.variants`, `environment.default`, and `template_overrides`. On save: parse, validate, persist to `repo.environment`. `template_overrides` is stripped before any `.agor.yml` export.
- **Bottom editor (worktree):** **admin-only.** Direct YAML editing of the 6 rendered commands is restricted to admins. Members do not see the `[Edit]` button on the bottom editor — only the Variant picker + Render button. Rationale: admins curate the set of commands that can run; members pick from that curated list and apply. This makes the admin's variant library the effective allowlist (complements the deny-list guard from PR #1034).
- **Variant picker + Render button:** available to **members and up**. Changing the dropdown doesn't take effect until Render is clicked. Render re-evaluates with the current repo variant + `template_overrides`, overwrites the bottom editor contents. If the snapshot has unsaved manual edits (admin only), Render prompts a confirm (`"Rendering will discard your local edits. Continue?"`). For members, Render always applies cleanly (no manual edits possible).
- **Start/Stop/Nuke/Logs buttons:** gated by `managed_envs_minimum_role` as today — orthogonal to the edit permissions above.
- **Empty-variants state.** When a repo has no variants configured, the bottom section shows a disabled picker and a one-liner: *"No environment variants configured. Ask an admin to set up commands in the repo editor above."* No weird unlabeled empty dropdown.
- **No stale-snapshot tracking.** If an admin edits a variant after a worktree has already rendered, the worktree snapshot is silently outdated — no banner, no dirty flag. Users decide if/when to re-render; worktrees are short-lived enough that this isn't worth instrumenting.
- **Docs link** inline in each editor's edit mode — points to `https://agor.live/guide/environment-configuration`. Section anchors for `#variants`, `#template-overrides`, `#template-vars`.

### Permission summary

| Action | Member | Admin |
|---|---|---|
| View repo config (top editor) | ✅ read-only | ✅ |
| Edit repo variants / `template_overrides` | ❌ | ✅ |
| Import / export `.agor.yml` | ❌ | ✅ |
| Pick variant + Render to worktree | ✅ | ✅ |
| Edit worktree rendered commands directly | ❌ | ✅ |
| Start / Stop / Nuke / Logs | per `managed_envs_minimum_role` | per `managed_envs_minimum_role` |

### Validation on save

Minimal. Matches the "just valid YAML" bar:

- **Both editors:** parse as YAML; reject on syntax error with line number.
- **Repo editor:** `environment.variants` is a map of variant-name → object; each variant has `start` and `stop` **after `extends` resolution** (at minimum); `environment.default` references a variant that exists; `extends` is single-level (reject if `variants[X].extends = Y` and `variants[Y].extends` is set); `extends` target must exist. Unknown top-level keys warn but don't block (forward-compat).
- **Worktree editor:** 6 known keys (`start`, `stop`, `nuke`, `health`, `app`, `logs`); `start` + `stop` required; values are strings.
- **Not validated pre-save:** Handlebars template correctness. Broken templates show their errors at render time — fast enough feedback loop.
- **Security:** deny-list check (PR #1034) runs on the final rendered string at execute time, not at save time. Keeps the editors free of false-positive noise while preserving the execution-time guard.

---

## 5. Import / export behavior

Both actions target **`$WORKTREE_PATH/.agor.yml`** — the `.agor.yml` in the currently open worktree's working directory, not the repo's default branch. This is the existing behavior (`repos.ts:789`) and it's the right one: admins iterate on `.agor.yml` in a branch, commit, PR it up, and it rolls out like any other repo change. Most of the time the file is identical across branches; when it isn't, the worktree you're editing from wins.

Two admin actions on the repo editor header; both short-circuit through a confirm dialog.

**Import `.agor.yml`** — reads from disk, parses, and replaces `environment.variants` + `environment.default` in the repo editor.

> *"Import `.agor.yml`? This will replace your repo-level variants with the file contents. Your `template_overrides` and worktree-level configurations are preserved. Continue?"*
> `[ Cancel ]` `[ Import ]`

**Export `.agor.yml`** — writes `environment.variants` + `environment.default` to the file. `template_overrides` is stripped.

> *"Export to `.agor.yml`? This will overwrite the file in the repo root. `template_overrides` stays local and will not be written. Continue?"*
> `[ Cancel ]` `[ Export ]`

Semantics worth pinning:

- Import is **replace, not merge** for variants. A variant that exists in DB but not in the file is dropped. (Simpler than partial merge; the repo file is treated as authoritative by design.)
- Import **never** touches `template_overrides` or any worktree's rendered commands.
- Export **never** writes `template_overrides`. Parser also refuses any `template_overrides:` key seen in an imported `.agor.yml` (defense in depth against accidental commits).
- No undo button in v1 — the repo editor has its own Edit → Cancel flow, and users can re-edit manually. `.agor.yml` itself is in git.

---

## 6. Migration path

| Step | What happens | When |
|---|---|---|
| 1 | Schema migration: rename `repos.environment_config` → `repos.environment` (JSON). Wrap existing value as `{ version: 2, default: "default", variants: { default: <old-value> }, template_overrides: {} }`. | On daemon upgrade |
| 2 | Add `worktrees.environment_variant` (default `"default"`). | Same migration |
| 3 | Existing `worktree.start_command` / `stop_command` / etc. kept as-is — they're already the rendered snapshot this design formalizes. | No action needed |
| 4 | `.agor.yml` v1 parser keeps working — treats the flat `environment: { start, stop, … }` block as `variants.default`. Export writes v2 by default. | Immediate |
| 5 | Preset's existing `daemon.host_ip_address` in `~/.agor/config.yaml` keeps working. Docs recommend migrating it into per-repo `template_overrides` for new setups. | No forced migration |
| 6 | Deprecate direct reads of the six rendered fields in favor of a `getWorktreeEnvCommands(worktree)` helper (future-proofing if we change storage later). | Before any further schema change |

Zero forced user action. Existing repos keep working as a single `default` variant. Preset's current workflow continues; `template_overrides` becomes the recommended home for new local template values.

---

## 7. Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| **Multiple `.agor-<variant>.yml` files** | Clutters repo root; implicit default; triples import UX surface. |
| **Multi-level `extends` inheritance** (`full → postgres → lean`) | Rejected: readers have to trace chains to understand what runs. Single-level is the sweet spot — common case is "same as X with one field changed," which single-level covers; anything deeper is usually a sign you want a new base variant anyway. |
| **Letting members hand-edit worktree rendered commands** | Rejected: would bypass the admin-curated allowlist. Members pick from variants the admin signed off on; manual string edits remain admin-only. |
| **Embed local overrides inside `.agor.yml` with a `local:` block + `.gitignore`** | User has to `.gitignore` a partially-committed file. Merge conflicts on every pull. `template_overrides` in DB removes the file entirely. |
| **Form-based UI per field (like today)** | Hides YAML structure; creates divergence between "form state" and "stored state"; harder to paste/diff/comment on. YAML editors are honest and copy-paste-friendly. |
| **Sparse-overrides map on the worktree (`environment_overrides: { start?: ... }`)** | Preserves template link but adds read-time layering that's hard to explain. Rendered snapshot + "re-render" button covers the realistic case (short-lived worktrees). |
| **Diff-modal on import** | Over-engineered vs. a clear confirm dialog. `.agor.yml` lives in git for diffs users actually want. |
| **Arbitrary-path `.agor.yml` upload** | Adds a third source of truth not tracked in git or DB. `template_overrides` handles the "not in git" case cleanly. |
| **CRDT / per-field merge on import** | Shell commands merge badly piece-wise. Replace-semantics is simpler and more honest. |
| **Validating Handlebars syntax pre-save** | Fast feedback already exists at render time. Pre-save validation adds noise for little benefit. |

---

## 8. Decisions (resolved in review)

| Question | Decision |
|---|---|
| Who picks the variant? | Members pick from the admin-curated list and Render. Admins can additionally hand-edit the rendered snapshot. |
| Runtime variant switching on a running env? | No special handling. Worktree state is the user's responsibility; dropdown doesn't affect running containers until they Stop/Start. |
| `template_overrides` visibility for members? | Team-visible (read-only). Admins can edit. Safety note in §2b: not for secrets — use the session env-var system for those. |
| `.agor.yml` path for import/export? | Always `$WORKTREE_PATH/.agor.yml`. Iterate on a branch, PR the change up, rollout is the same as any other repo file. |
| `template_overrides` scoping? | Root-level, applies to all variants. No per-variant overrides. |
| Stale-snapshot tracking when a variant changes? | None. Users understand that changing the template requires a re-render to take effect; no banner or dirty-state tracking. |
| Empty-variants state? | Disabled picker + "ask an admin to configure environments" one-liner. |
| Per-variant RBAC (hide some variants from members)? | Dropped. Admin-curated list is already the member allowlist; hiding a subset inside it adds complexity without a real use case. |
| Docs location? | `apps/agor-docs/pages/guide/environment-configuration.mdx` at `https://agor.live/guide/environment-configuration`. Linked from each editor's edit-mode toolbar. Follow-up PR to the implementation. |
| `extends` across `.agor.yml` v1 import? | v1 files have no variants → wrapped as `variants.default` with no `extends`. Safe; flag in migration docs. |

No open questions remaining at the design level. Implementation may surface smaller decisions (exact UI copy, error message wording, etc.) — those will be handled in review of the schema / UI PRs.

---

*Feedback welcome — happy to split implementation into a schema PR, a UI PR, and a docs PR.*
