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

A narrow escape-hatch for deployment-local values already exists: `config.daemon.host_ip_address` (set in `~/.agor/config.yaml`) flows into `host.ip_address` in the template context. Preset uses this to inject a hard-coded host IP without leaking it into the shared `.agor.yml`. This is the seed of the "deployment-local overrides" layer this doc formalizes.

**Known pain points** (from the task brief and code):

- One template set per repo — no `lean` vs `postgres` variants. Superset has two compose files today with nothing to model that in Agor.
- Import silently wipes local edits to `repo.environment_config`. No diff, no confirm, no undo.
- Worktree-level direct edits drift silently from the repo template — "Regenerate" exists but is all-or-nothing.
- "Deployment-local" logic is a single named var (`host.ip_address`). Any other local-only value (Preset's IP-bearing commands, custom registry URLs, internal Slack tokens) has no home except per-worktree edits that bypass the shared template.

---

## 2. Proposed `.agor.yml` schema — named variants

```yaml
# .agor.yml — repository-shared, committed to git
version: 2                         # bump from implicit v1 (single-set)

environment:
  default: lean                    # variant picked when worktree is created
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
      extends: lean                # inherit fields, then override
      start: "docker compose -p agor-{{worktree.name}} up -d --build"
      stop:  "docker compose -p agor-{{worktree.name}} down"
      nuke:  "docker compose -p agor-{{worktree.name}} down -v"
      logs:  "docker compose -p agor-{{worktree.name}} logs --tail=100"

    full:
      description: "Postgres + Redis + Celery + worker + beat"
      extends: postgres
      start: "COMPOSE_PROFILES=full docker compose -p agor-{{worktree.name}} up -d --build"
```

**Worktree records its variant** in a new column:

```ts
// packages/core/src/types/worktree.ts
export interface Worktree {
  // ...existing fields...
  environment_variant?: string;       // e.g. "lean" | "postgres" | "full"
  environment_overrides?: Partial<{   // per-worktree tweaks; merged on render
    start: string; stop: string; nuke: string;
    health: string; app: string; logs: string;
  }>;
}
```

Design notes:

- **`extends`** keeps the YAML tight — Superset's `postgres` and `full` only list the fields that actually diverge from `lean`.
- `default` is the variant a new worktree gets; can be overridden in the create-worktree UI.
- Health/app URL templates live inside each variant (they usually differ per-variant — different ports, different health endpoints).
- The existing v1 flat schema (`environment: { start, stop, ... }`) remains valid and is auto-migrated to `version: 2` with a single `default: "default"` variant.

---

## 3. Override layering model

Three layers, precedence **low → high**:

```
  repo variant (.agor.yml or repo.environment_config)
        └─► deployment-local config (~/.agor/config.yaml)
                  └─► per-worktree override (worktree.environment_overrides)
```

### 3a. Repo variant — shared source of truth
- Authored by repo maintainers. Committed in `.agor.yml`.
- Stored in DB as `repo.environment_variants: Record<string, RepoEnvironmentVariant>` (rename `environment_config` → `environment_variants` with a migration; existing config becomes `variants.default`).

### 3b. Deployment-local config — not committed, per-Agor-install
- Lives in `~/.agor/config.yaml` under a new `environment` key:

```yaml
# ~/.agor/config.yaml
daemon:
  host_ip_address: 10.0.1.42        # already exists — keep

environment:
  # Scoped by repo slug, then variant. Variant "*" applies to all.
  overrides:
    preset-io/superset:
      "*":
        # add template vars available as {{local.*}}
        vars:
          internal_registry: "registry.preset.io"
          aws_profile: "preset-dev"
      postgres:
        # per-field string override (wins over repo variant, loses to worktree)
        start: "AWS_PROFILE={{local.aws_profile}} docker compose -p agor-{{worktree.name}} up -d"
```

- Exposed in the template context as `{{local.*}}` (new namespace, parallel to `{{host.*}}`).
- **Never** written to `.agor.yml`. Never sent to the UI for non-admins. Admin UI surfaces it read-only with a "local override" badge.

### 3c. Per-worktree override — escape hatch
- Today's worktree fields (`worktree.start_command`, etc.) already serve this purpose, but they're **rendered snapshots** — editing them severs the link to the repo template forever.
- Replace with `worktree.environment_overrides: { start?, stop?, nuke?, health?, app?, logs? }` — a sparse map of fields the user explicitly wants to override. Fields not in the map render from variant + local every time.
- Migration: existing `worktree.{start_command,...}` values are compared against `render(repo_variant + local)`; any field that differs is moved into `environment_overrides`, the rest are discarded (so "Regenerate" is the default behavior from now on).

### Conflict resolution
Rendering a worktree's effective command for field `F`:

```
1. resolved = variants[worktree.environment_variant ?? default][F]
   (resolved through `extends` chain)
2. if local.environment.overrides[repo.slug][worktree.environment_variant]?.[F]: use that
   else if local.environment.overrides[repo.slug]["*"]?.[F]: use that
3. if worktree.environment_overrides?.[F]: use that
4. Handlebars-render the winning string with { worktree, repo, host, local, custom }
```

No merging inside a single field — last writer wins per-field. This keeps the mental model simple (three boxes, one winner per command) and mirrors how CSS cascades.

---

## 4. UI proposal (wireframe-level)

### 4a. Worktree create modal — variant picker
```
┌─ Create worktree: feat/new-filter ─────────────────────┐
│ Repo:     preset-io/superset                           │
│ Branch:   feat/new-filter                              │
│                                                        │
│ Environment variant:                                   │
│   ( ) lean      — SQLite, single container, fastest   │
│   (•) postgres  — Postgres + Redis + Celery           │
│   ( ) full      — + worker + beat                     │
│   ( ) none      — I'll set up commands myself         │
│                                                        │
│ [ Preview resolved commands ▾ ]                        │
│                                                        │
│              [ Cancel ]  [ Create worktree ]           │
└────────────────────────────────────────────────────────┘
```

### 4b. Worktree Environment tab — layered view
```
┌─ Environment — feat/new-filter (variant: postgres) ───────────┐
│  [ Start ] [ Stop ] [ Restart ] [ Nuke ] [ Logs ]              │
│                                                                │
│  Variant: postgres ▾     [ Change variant... ]                 │
│                                                                │
│  Start Command                                     [Edit]      │
│    Repo:   docker compose -p agor-{{worktree.name}} up …       │
│    Local:  AWS_PROFILE=preset-dev docker compose -p …  🏠      │
│    This:   (using local)                                       │
│    ────────────────────────────────────────────                │
│    Rendered: AWS_PROFILE=preset-dev docker compose             │
│              -p agor-feat-new-filter up -d --build             │
│                                                                │
│  Stop Command                                      [Override]  │
│    Repo:   docker compose -p agor-{{worktree.name}} down       │
│    This:   (using repo)                                        │
│                                                                │
│  Health URL                                        [Edit]      │
│    Repo:   http://{{host.ip_address}}:…                        │
│    This:   http://localhost:9001/health            ⚠ overridden│
└────────────────────────────────────────────────────────────────┘
```

Key UI ideas:

- Three stacked rows per command: **Repo** (grey, read-only template), **Local** (🏠 badge, admin-only, read-only), **This** (worktree override, user-editable with Revert).
- The row wins that has a value + highest precedence; others are dimmed.
- "Rendered" line at the bottom — the actual string that will run, with all vars substituted.
- "⚠ overridden" pill next to any field with a `worktree.environment_overrides[F]` set. Clicking reverts to the layer below.
- Dirty-state: if `.agor.yml` on disk differs from `repo.environment_variants`, show a yellow banner: *"`.agor.yml` on disk has changed — [View diff] [Import]"*.

### 4c. Import safety
The import button always shows a **three-column diff** before applying:

```
┌─ Import .agor.yml ─ preset-io/superset ────────────────────────┐
│                                                                │
│  Variant       Field       Current (DB)        File (.agor.yml)│
│  ─────────────────────────────────────────────────────────────│
│  postgres      start       docker compose…     docker compose…│
│                                                                │
│  full          start       (new)                COMPOSE_PROF…  │
│                nuke        (new)                docker compose…│
│                                                                │
│  lean          app         http://localh…       http://{{host…│
│                                                                │
│  ☐ Also overwrite worktree-level overrides (not recommended)   │
│  ☑ Preserve worktree.environment_overrides (default)           │
│                                                                │
│                        [ Cancel ]  [ Import 4 changes ]        │
└────────────────────────────────────────────────────────────────┘
```

- Default: imports repo-level variants only; worktree overrides are untouched.
- Import is recorded as an event (`repo.environment_config_imported`) with a snapshot of the previous state, enabling an **"Undo last import"** button for 24h.

---

## 5. Import/export behavior (recommendation)

| Situation | Default behavior | User override |
|---|---|---|
| `.agor.yml` present, no repo config in DB | Auto-import on first worktree create for that repo (quiet) | `--no-auto-import` flag in repo settings |
| Import, DB config matches file | No-op, toast "already in sync" | — |
| Import, DB has additional variants not in file | Keep DB-only variants; merge from file | Checkbox: "Replace (delete local-only variants)" |
| Import, file has fields that conflict with DB | Show diff modal (see 4c), user confirms | — |
| Export, file has fields not in DB | Warn: *"file has variants `xyz` not in current config; export will drop them"* | Checkbox: "Proceed" / "Cancel" |
| Export, commits not staged | Offer "create branch + commit .agor.yml" option | — |

Export never writes the `local` layer (already true for `host.ip_address`). The parser in `agor-yml.ts` should refuse any `local:` or `overrides:` keys at the top level to prevent accidental secrets in repo-shared files.

---

## 6. Migration path

Backward compatibility is the main constraint since existing repos already have a single-template config.

| Step | What happens | When |
|---|---|---|
| 1 | Schema migration: rename `repos.environment_config` → `repos.environment_variants` (JSON column); wrap existing value as `{ default: <old value> }`. | On daemon upgrade |
| 2 | Add `worktrees.environment_variant` (default `"default"`), `worktrees.environment_overrides` (JSON, nullable). | Same migration |
| 3 | Render-time migration for existing worktrees: diff current `worktree.start_command` etc. against render of `variants.default`; write the diff to `environment_overrides`. Clear the rendered fields. | Lazy, on first worktree read |
| 4 | `.agor.yml` v1 parser keeps working — emits `{ version: 1, variants: { default: {...} } }` internally. Export writes v2 format by default; flag `--legacy` to emit v1. | Immediate |
| 5 | UI variant picker shows only `default` for v1 repos, with a "Add variant" CTA that auto-upgrades the file on next export. | Feature flag `env_variants: true` for 1 release cycle, then GA |
| 6 | Deprecate direct reads of `worktree.start_command` etc. in services — route everything through a `resolveEnvironmentCommands(worktree)` helper that applies the layering. | Done before removing the columns |

No forced user action. Existing repos keep working as the `default` variant. Preset's current host-IP workflow keeps working because `host.ip_address` continues to be populated the same way.

---

## 7. Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| **Multiple `.agor-<variant>.yml` files** (`.agor-lean.yml`, `.agor-postgres.yml`) | Loses the `extends` ergonomics; clutters repo root; makes "default" selection implicit; three times the import UX surface. |
| **Embed local overrides inside `.agor.yml`** with a `local:` block the user edits but `.gitignore`s | User has to `.gitignore` a file that also has committed content — error-prone. Merge conflicts on every pull. |
| **No variants — just let users fork repo.environment_config into N copies via UI** | Accumulator-of-sets problem stated in the brief. No shared source of truth across deployments. |
| **Variants as separate DB rows on a `repo_environment_variants` table** instead of JSON column | Premature normalization — variants are small (~6 fields × a few variants), always loaded together with the repo, never queried by field. JSON column is simpler and matches the YAML shape 1:1. |
| **Allow loading `.agor.yml` from arbitrary paths / uploads** | Adds a third source of truth (not-in-repo, not-in-DB) that has to be version-tracked separately. The config-file `overrides:` block already covers the "local file, not committed" case. Can be added later if needed for air-gapped / review workflows. |
| **Per-field merge on import (CRDT-style)** instead of diff-and-confirm | Confusing when a field is a shell command — partial merges produce nonsense. Diff modal is simpler and more honest. |
| **Git-versioned history of `repo.environment_variants` in DB** | Heavy for what this is. The "undo last import" 24h window covers the realistic accident case; `.agor.yml` itself is in git for long-term history. |

---

## 8. Open questions

1. **Who picks the variant — worktree creator or repo admin?** Current proposal: creator picks at worktree-create time; default from `.agor.yml`. Admins can change it later. Alternative: admin-only, to prevent members running surprise configurations.
2. **Should `worktree.environment_variant` be changeable at runtime?** If I change from `lean` → `postgres` on a running worktree, do we auto-nuke + restart, or just update the commands for next start?
3. **Namespace for deployment-local vars: `{{local.*}}` vs `{{deployment.*}}` vs nest under `{{host.*}}`.** `local` is short but overloaded (local vs. remote); `deployment` is precise but verbose. Leaning `local`.
4. **Do we need variant visibility scoping** (e.g. "this variant is admin-only, hide from members")? Relevant if orgs want a `production-like` variant that shouldn't be spawnable by everyone. Could piggy-back on `managed_envs_minimum_role` or become a per-variant field.
5. **`.agor.yml` in non-default branches.** If worktree `feat/x` has a different `.agor.yml` than `main`, which wins on import? Current code uses the worktree's `.agor.yml` if `worktree_id` is passed (`repos.ts:789`). Is that right, or should `main` always win for repo-level config?
6. **Deny-list interaction** (ref PR #1034). Does the deny-list apply to the rendered command (post-layering) or to each layer separately? Post-layering is simpler but can be surprised by a local override that injects a denied pattern. Recommend: check the final rendered string.
7. **Sandboxing the variant name.** `worktree.environment_variant` becomes a user-controlled string that the daemon looks up in a map. Path-traversal-style concerns are low (no filesystem lookup), but we should normalize (lowercase, `[a-z0-9-]+`, length cap) and reject unknown variants at write time.

---

*Feedback welcome — happy to split this into multiple PRs (schema first, UI after) or adjust scope based on review.*
