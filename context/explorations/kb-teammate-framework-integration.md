# Knowledge Base Assistant Framework Integration

**Date:** 2026-06-07  
**Scope:** How Agor Knowledge Base should support the `preset-io/agor-assistant` file-based assistant framework. This is an options/design note, not an implementation PR.

## Current state inspected

Agor KB today is DB-backed markdown with namespaces, immutable document versions, internal search units, optional semantic embeddings, graph links, MCP tools, and a UI page:

- Types: `packages/core/src/types/knowledge.ts`
- Schema/repositories: `packages/core/src/db/schema.{sqlite,postgres}.ts`, `packages/core/src/db/repositories/knowledge.ts`
- Services: `apps/agor-daemon/src/services/knowledge-*.ts`
- MCP tools: `apps/agor-daemon/src/mcp/tools/knowledge.ts`
- UI: `apps/agor-ui/src/pages/KnowledgePage.tsx`, `components/KnowledgeGraph/`, `AutocompleteTextarea/kbMentions.ts`
- Existing agent-editing design: `context/explorations/kb-agent-targeted-edits.md`

The public `preset-io/agor-assistant` framework is a markdown file manifold. Its core files are `AGENTS.md`, `BOOT.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `BOARD.md`, `HEARTBEAT.md`, `TOOLS.md`, `skills/`, and daily logs under `memory/YYYY-MM-DD.md`. It currently tells agents that filesystem files are state/memory, and git is backup.

## Recommendation summary

1. **Give every Agor Assistant branch an assigned KB namespace.** Store the namespace slug/id in `branch.custom_context.assistant.kb` and mirror it on the KB namespace as `kind: "branch"`, `branch_id`, and metadata identifying it as assistant-owned.
2. **Make context-aware assistant tools the default write path.** Generic `agor_kb_put`, `agor_kb_edit`, and `agor_kb_search` should remain, but assistants should mostly call higher-level tools such as `agor_assistant_memory_append` and `agor_assistant_kb_search` that infer the assistant namespace from the current MCP session's branch.
3. **Default assistant operational KB to private.** Public assistants/docs should be opt-in. If an assistant/branch is private, assistant memory writes should force `visibility: "private"` and `edit_policy: "owner"` or a branch-scoped equivalent once KB ACLs exist.
4. **Seed, then decouple KB ACLs from branch ACLs.** Assistant namespaces should be initialized from branch ownership/visibility, but KB should own its own permission model after that. Branch changes may offer an explicit sync/apply action, but KB reads/writes should not virtualize every decision through branch RBAC forever.
5. **Migrate by layering KB over files, not replacing files immediately.** Keep the framework repo as portable bootstrap/instructions/skills scaffolding. Move volatile/personal memory and curated docs into KB gradually, with a filesystem fallback/export path.
6. **Use append-only daily memory docs with deterministic block IDs.** Append one logical memory entry as one stable markdown block under `memory/YYYY-MM-DD.md`. Chunk/index by explicit block boundaries first, then headings/auto-split as fallback. Reuse unchanged block hashes across versions so only new/changed chunks require embeddings.

## Product model

### Assistant namespace

**Recommended shape:** one operational namespace per assistant branch.

```ts
// branch.custom_context.assistant.kb (proposed)
{
  namespace_id: string;
  namespace_slug: string; // e.g. assistant-private-coachbot or assistant-<branch-short-id>
  visibility_default: 'private' | 'public';
  memory_path_template: 'memory/{{YYYY-MM-DD}}.md';
  docs_root: 'docs/';
  skills_root: 'skills/';
  policy: 'private' | 'branch' | 'public';
}
```

Use the existing `kb_namespaces` columns where possible:

- `kind: "branch"` for assistant namespaces in V1 because assistants are branch-backed today.
- `branch_id` set to the assistant branch.
- `owner_user_id` and `created_by` from the assistant creator.
- `visibility_default: "private"` unless explicitly public/team.
- `metadata.assistant = { displayName, frameworkRepo, branchId }` for discovery and migrations.

**Slug:** deterministic and stable, preferably `assistant-<branchShortId>` or `assistant-<sanitized-branch-name>-<branchShortId>`. Human display name can change; slugs should not.

### Namespace assignment options

| Option                                     | Summary                                                                                                       | Pros                                            | Cons                                                                         | Recommendation                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
| A. Instruction-driven only                 | Tell agents to use a namespace in `AGENTS.md`/bootstrap prompt.                                               | No backend work.                                | Easy to forget, unsafe defaults, brittle across tools/models.                | Not enough.                   |
| B. Configured per assistant                | Store namespace in assistant config and show it in UI.                                                        | Explicit, portable, discoverable.               | Generic tools can still write elsewhere by mistake.                          | Necessary but not sufficient. |
| C. Tool-enforced context                   | Assistant tools infer namespace from current session/branch and do not accept arbitrary namespace by default. | Safest UX; fewer prompt tokens; better privacy. | Needs session context and resolver.                                          | Recommended default.          |
| D. Fully forced namespace for all KB tools | Generic KB tools silently rewrite/force namespace.                                                            | Strong isolation.                               | Surprising for legitimate cross-namespace docs/search; bad admin/tooling UX. | Avoid.                        |

**Answer:** assign/configure the namespace and make assistant-specific tools enforce it by default. Leave generic KB tools explicit.

### Discovery

Agents should discover their namespace in three ways, in order:

1. **Context-aware MCP:** `agor_assistant_context` returns assistant branch config, board, namespace, privacy policy, and canonical roots.
2. **Session/branch reads:** existing `agor_sessions_get_current` / branch tools can expose `branch.custom_context.assistant.kb` once populated.
3. **Bootstrap instructions:** `BOOT.md` / `AGENTS.md` in the framework should say: first call assistant context; do not hard-code namespace slugs.

### Assistant Knowledge settings

The product control point should be an Assistant/Branch modal **Knowledge** tab, with a compact summary also reachable from `BranchCard -> Permissions`. This tab should configure the assistant's KB capability envelope, not just display a namespace.

Suggested settings:

- **Primary namespace:** assigned assistant namespace and deep link.
- **Namespace visibility:** private/public/default sharing policy for new documents.
- **Write confinement:** whether the assistant can write only to its namespace, to selected namespaces, or anywhere the operator/user can write.
- **Read scope:** own namespace only, own + selected shared namespaces, or all namespaces the caller can read.
- **Publish policy:** whether the assistant may publish analysis/docs to shared/public namespaces, and whether that requires confirmation.
- **Search scope default:** own namespace first, selected shared namespaces, or all readable KB.
- **ACL sync action:** optional "seed/update from branch permissions" button, instead of invisible virtual coupling.

This gives operators an explicit way to tighten guarantees for high-trust assistants. A personal assistant can be confined to its private namespace. A documentation assistant can be allowed to publish into a team namespace. A repo assistant can read a broad corpus but only write under its assigned branch/assistant namespace.

### Effective operating user

The assistant KB policy should be evaluated against an **effective operating user**. Agor already has this concept in practice:

- Interactive sessions run as the session creator/caller.
- Schedules run as `schedules.created_by`; schedule creation injects the caller as `created_by`, and run/patch guards prevent normal users from changing or manually running another user's schedule.
- Gateway sessions resolve an effective user from platform-user alignment when enabled; otherwise they use the configured channel `agor_user_id` ("Post messages as"). Alignment failures are rejected rather than silently falling back.

That means assistant KB grants are not independent capabilities. They are an assistant-specific **allowlist intersected with the effective user's KB rights**:

```text
effective_access = assistant_policy_scope ∩ effective_user_kb_access
```

If an operator grants the assistant "Super Private Namespace" but the effective operating user cannot read it, the assistant cannot read it either. If the assistant is set to "same as operating user", the assistant policy scope is effectively unbounded, but the user's own KB permissions still apply.

## Memory API/tooling

The assistant framework should not ask agents to manually edit a large markdown file for every memory write. Agents are better at “remember this one thing” than at deterministic append/chunk hygiene.

### Proposed MCP/API surface

Add assistant-scoped tools layered on top of the generic KB services:

```ts
type AssistantMemoryAppendInput = {
  text: string; // one bullet/observation/decision, plain text or markdown
  category?: 'note' | 'decision' | 'preference' | 'project' | 'learning' | 'task' | 'other';
  importance?: 'low' | 'normal' | 'high';
  date?: string; // YYYY-MM-DD, default server/current session date
  source?: {
    sessionId?: string;
    taskId?: string;
    branchId?: string;
    documentId?: string;
    uri?: string;
  };
  tags?: string[];
  visibility?: 'private' | 'public'; // optional, but bounded by assistant policy
  idempotencyKey?: string; // optional caller-supplied de-dupe key
};

type AssistantMemoryAppendResult = {
  namespace: { namespace_id: string; slug: string };
  document: { document_id: string; path: string; uri: string; visibility: string };
  entry: {
    entry_id: string;
    block_hash: string;
    date: string;
    ordinal: number;
  };
  baseVersion?: KnowledgeVersionToken;
  newVersion: KnowledgeVersionToken;
};
```

MCP tool names:

- `agor_assistant_context` — read-only, current session required.
- `agor_assistant_memory_append` — append one memory entry to the current assistant namespace.
- `agor_assistant_memory_search` — search current assistant memories, defaulting to `kind: "memory"` and `pathPrefix: "memory/"`.
- `agor_assistant_kb_search` — search current assistant namespace plus optional explicitly named shared namespaces.
- Later: `agor_assistant_memory_promote` to curate daily notes into `MEMORY.md`/`memory/curated.md` style docs.

REST/service shape can be `/assistant/context`, `/assistant/memory` or `/kb/assistant-memory`. Prefer a KB-adjacent service if it mainly wraps KB documents, but use “assistant” in MCP names because that is the agent-facing product concept.

### Relationship to generic KB tools

- `agor_kb_put`: create/update whole documents. Good for docs, guides, skills, and imports.
- `agor_kb_edit`: deterministic targeted edits. Good for curated memory or docs.
- `agor_assistant_memory_append`: append-only semantic memory primitive. It should internally call repository/service helpers, not ask the model for `KnowledgeEditOp[]`.
- `agor_kb_search`: cross-KB explicit search.
- `agor_assistant_*_search`: opinionated search with namespace and privacy defaults.

The generic tools should remain available because assistants sometimes need shared/team docs. The assistant tools should be the happy path and should return enough URI/reference metadata for graph links.

## Privacy and visibility defaults

### Recommended defaults

- Assistant operational namespace: **private by default**.
- Daily memories: **private by default**.
- `IDENTITY`, `SOUL`, `USER`, long-term memory, and learned preferences: **private by default**.
- Framework/template docs and generic skills: public or shared only when intentionally published outside the assistant namespace.
- If an assistant branch is private or `others_can: "none"`, assistant memory writes should **force private**.
- If an assistant is configured as team/shared, writes may default to private-to-team/branch once KB has richer ACLs; until then, use document `visibility: "private"` plus owner/admin access or `public` only by explicit config.

### Why private by default

The assistant framework accumulates `USER.md`, preferences, operational logs, repo names, external-system notes, PR context, and sometimes personal data. The public `agor-assistant` repo itself warns that public backup of assistant state is unsafe. KB should not recreate that footgun with public default visibility.

### Context-aware defaults

Assistant MCP tools should infer defaults from current context:

1. Resolve current session (`ctx.sessionId`).
2. Load its branch.
3. If branch is an assistant, load `branch.custom_context.assistant.kb`.
4. Apply namespace and visibility policy.
5. Reject or warn on attempted broadening (`visibility: public`) unless config permits it.

If there is no current session context, assistant-scoped write tools should fail with the same style of actionable error as existing session-context tools.

## Operational area, ACLs, and search scope

### Namespace/place

Create a special KB operational area per assistant namespace:

```text
agor://kb/assistant-<branch-short-id>/
  identity/identity.md      # optional migrated IDENTITY.md
  identity/soul.md          # optional migrated SOUL.md
  identity/user.md          # optional migrated USER.md
  memory/YYYY-MM-DD.md      # append-only daily notes
  memory/curated.md         # optional distilled long-term memory
  memory/learnings/*.md     # optional lessons
  docs/*.md                 # assistant-owned docs
  skills/*.md               # assistant-owned markdown skills
  prompts/*.md              # reusable prompts/templates
  ops/board.md              # optional migrated BOARD.md
  ops/tools.md              # optional migrated TOOLS.md
```

Do **not** create a new namespace per branch the assistant works on by default. Most delegated coding branches are work products, not the assistant's own mind. Use links/graph edges from memory entries to branch/session/task nodes instead.

Per-work branch namespaces can still exist for project docs (`kind: "branch"`, `branch_id`), but they should be separate from the assistant operational namespace.

### Access coupling

Current KB permissions are document-level `visibility` plus owner/admin/public-edit. Namespaces have `owner_user_id`, `repo_id`, `branch_id`, and visibility defaults, but no ACL table. Branch RBAC has richer semantics behind `execution.branch_rbac`.

**Recommendation:** do **not** virtualize KB ACLs entirely through branch RBAC. Use branch context to seed namespace ACLs and for helpful UI affordances, but let KB have its own durable security model.

Why:

- KB documents can outlive or move beyond a branch.
- Assistants may intentionally publish docs into team/global spaces.
- A collaborator may have access to an assistant without being its primary owner.
- Search needs a simple rule: return everything the searching user can read, regardless of which branch originally seeded access.
- Branch visibility changes should not silently expose or hide sensitive KB memories unless the operator intentionally applies that policy.

**Current limitation:** KB has only document-level `public`/`private`, owner/admin checks, and public-edit policy. It does not yet have real namespace ACLs. That makes "explicit namespace grants" impossible to model precisely without adding ACL tables or a permission resolver.

**V1 pragmatic rule before KB ACL tables exist:**

- To read/write assistant-scoped KB through assistant tools, caller must be able to access the current assistant session/branch and satisfy document ownership/visibility checks.
- Assistant-owned private docs are created by the assistant branch/session creator. Admins can read/manage.
- For shared assistants, add an explicit assistant KB policy in `AssistantConfig` rather than assuming branch access means memory access.

**V2 target:** add KB namespace/document ACLs or namespace owners/members, seeded from branch owners but not permanently virtualized from them:

- `owner`: creator/admins and explicit namespace owners.
- `read`: branch owners and possibly users with branch `view`, depending on assistant policy.
- `write-memory`: assistant sessions and users with branch `prompt`/`all`, or explicit namespace write.
- `manage`: owners/admins.

Branch UI can include "Apply branch permissions to KB namespace" or "Keep in sync" as an explicit policy, but the default should be **seed-on-create** plus independent KB management.

### Search scope

Search should be user-access scoped, not assistant-owner scoped:

- A normal KB search returns documents the current user can read across all namespaces.
- Assistant-scoped search applies the assistant's configured read scope first, then the user's KB ACLs.
- If a user has access to an assistant but is not the primary assistant owner, they should still find that assistant's shared/readable memories/docs according to the assistant namespace ACL.
- Private assistant memories should not appear in broad search unless the user has explicit KB read access to that namespace/document.

This implies KB search cannot rely only on `document.visibility === public OR created_by === user`. It eventually needs namespace/document ACL joins (or a permission resolver) so shared assistant access is represented without making documents public.

### Capability guarantees

Generic KB tools are intentionally loosely coupled: an assistant can publish a design note into `global`, a team namespace, or its own namespace if the caller has permission. That flexibility is useful, but it is not a strong safety boundary.

Stronger guarantees should come from an assistant KB capability policy enforced by assistant-aware tools:

```ts
type AssistantKnowledgePolicy = {
  primaryNamespaceId: string;
  defaultVisibility: 'private' | 'public';
  readScope:
    | { mode: 'own_namespace' }
    | { mode: 'selected_namespaces'; namespaceIds: string[] }
    | { mode: 'all_user_readable' };
  writeScope:
    | { mode: 'own_namespace' }
    | { mode: 'selected_namespaces'; namespaceIds: string[] }
    | { mode: 'all_user_writable' };
  publicPublish: 'forbidden' | 'confirm' | 'allowed';
};
```

Assistant tools should use this policy to choose defaults and reject out-of-scope writes. Generic `agor_kb_*` tools can remain powerful/admin-like, but assistants should be instructed and UI-configured to prefer the assistant tools when operating on memory or assistant-owned docs.

Selected namespace grants should carry desired assistant capability (`read` or `read_write`) but must still be checked against the effective user's actual KB capability at request time. They are not a way to mint rights the user does not have.

## Deterministic memory append and chunking

### Document format

Daily memory docs should be valid markdown, append-mostly, and deterministic. Proposed format:

```markdown
# Memory — 2026-06-07

<!-- agor-memory:v1 date=2026-06-07 -->

<!-- agor-memory-entry id=01J... ordinal=000001 sha256=... -->

- 2026-06-07T14:23:11Z [decision] User prefers review-first PR workflow. (source: agor://session/...)
<!-- /agor-memory-entry -->

<!-- agor-memory-entry id=01J... ordinal=000002 sha256=... -->

- 2026-06-07T15:01:04Z [learning] For repo preset-io/agor, do not run `pnpm build` unless asked.
<!-- /agor-memory-entry -->
```

Rules:

- One API call appends one block.
- Server assigns `entry_id`, timestamp, ordinal, and `sha256` over normalized block payload.
- Server creates the daily document if missing: path `memory/YYYY-MM-DD.md`, kind `memory`, title from date.
- Existing blocks are never rewritten except for explicit repair/migration tools.
- Repeated calls with the same `idempotencyKey` return the prior entry.
- If concurrent appends race, the service retries against the latest version and preserves both entries.

### Chunking/indexing implications

Current indexing regenerates units per new document version and unit IDs include `version_id`, so unchanged chunks in a new version become new unit IDs and are re-embedded. That is acceptable for small docs but inefficient for daily append logs.

For assistant memory, use explicit block-aware units:

```ts
unit.identity_key = `memory-entry:${entry_id}`;
unit.content_sha256 = sha256(normalizedEntryText);
unit.metadata = {
  chunker_version: 'agor-memory-v1',
  entry_id,
  date,
  ordinal,
  category,
  source,
};
```

Recommended indexing evolution:

1. Add a memory-specific chunker that recognizes `agor-memory-entry` blocks and produces one unit per entry or per small batch of adjacent entries.
2. Make unit identity independent of `version_id` for block-addressed append-only units, or add a reuse step that copies embedding rows from the previous unit with the same `identity_key + content_sha256 + embedding_space`.
3. Mark only new/changed units as `pending`; unchanged units should be `ready` immediately by reusing previous embedding metadata/vector.
4. Keep the existing markdown heading/auto-split chunker as fallback for normal docs and legacy memory files.

This avoids recomputing embeddings for yesterday's unchanged entries every time today gets one more note.

## Framework migration

### What should stay file-based

Keep the assistant repo useful without Agor KB:

- `AGENTS.md` / `BOOT.md`: startup instructions and fallback behavior.
- `BOOTSTRAP.md`: first-run ritual, updated to initialize KB when available.
- Minimal `IDENTITY.md`, `SOUL.md`, `USER.md`, `BOARD.md`, `TOOLS.md`: local bootstrap/cache/export for agent platforms that do not have Agor KB.
- `skills/`: portable markdown skills and any platform-native skill packaging.
- Git backup docs: still useful for file-mode and for framework/template evolution.

### What should move to KB first

- Daily raw memory (`memory/YYYY-MM-DD.md`) via `agor_assistant_memory_append`.
- Curated long-term memory (`MEMORY.md`) as KB docs, edited with `agor_kb_edit` or future curate/promote tools.
- Assistant-specific docs/prompts/board notes that benefit from search/graph links.
- Assistant-specific markdown skills that should be searchable/discoverable across sessions.

### Compatibility strategy

1. **Dual-read, KB-preferred:** BOOT says: call `agor_assistant_context`; if KB is configured, read/search KB memory; otherwise read files.
2. **Dual-write optional:** During migration, append memory to KB and optionally materialize/export to files for backup/local readability.
3. **Filesystem export:** Provide `agor_assistant_kb_export` or reuse `agor_kb_materialize` to write KB snapshots into the assistant worktree for offline/local agents.
4. **Import path:** On first KB enablement, import existing `MEMORY.md`, `memory/*.md`, and selected identity files into the assigned namespace with provenance metadata.
5. **No breaking local workflows:** If Agor KB is off or unavailable, the public framework continues exactly as file-mode today.

## Options and tradeoffs

### Memory storage options

| Option                      | Pros                                                    | Cons                                                                       | Verdict                     |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------- |
| Continue file-only          | Portable; simple; git backup works.                     | Poor cross-session search; public-backup footgun; no graph/ACL/version UI. | Keep as fallback only.      |
| Whole-doc KB put from agent | Uses existing API.                                      | Model must manage append formatting/concurrency; re-embeds too much.       | Not recommended for memory. |
| Targeted KB edit append     | Uses `agor_kb_edit`; version-checked.                   | Still exposes markdown mechanics to agent; concurrency retries awkward.    | Useful intermediate.        |
| Dedicated memory append API | Safe, small inputs, deterministic chunks, policy-aware. | New service/tool.                                                          | Recommended.                |

### Namespace options

| Option                         | Pros                                              | Cons                                                             | Verdict                                           |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| One global assistant namespace | Easy browsing.                                    | Cross-assistant privacy and collisions.                          | Avoid.                                            |
| Per-user namespace             | Good for personal memories.                       | Assistants become folders; hard to delegate/share one assistant. | Useful shared search scope, not operational home. |
| Per-assistant branch namespace | Matches current assistant model; isolates memory. | Needs namespace provisioning and config.                         | Recommended.                                      |
| Per-working-branch namespace   | Good for project docs.                            | Fragments assistant identity/memory.                             | Supplemental only.                                |

## Implementation phases

### Smallest first PR

1. Extend `AssistantConfig` with optional `kb` metadata in `packages/core/src/types/branch.ts`.
2. On assistant creation, create or ensure a private KB namespace linked to the assistant branch (`kind: "branch"`, `branch_id`, metadata) and store it in `custom_context.assistant.kb`.
3. Add a minimal assistant KB policy object: primary namespace, default visibility, read scope, write scope, public publish policy.
4. Add `agor_assistant_context` MCP tool that resolves current session → branch → assistant config → namespace and returns policy/default roots.
5. Update assistant bootstrap prompt/framework docs to prefer `agor_assistant_context` and KB when present, while preserving file fallback.

This gives agents a stable namespace without changing memory writes yet.

### Phase 2: Assistant Knowledge UI

- Add a Branch/Assistant modal **Knowledge** tab.
- Surface namespace, visibility, read/write scope, public publish policy, and search defaults.
- Add a compact KB section/link under permissions so branch owners understand the relationship.
- Add explicit seed/sync action from branch permissions to KB namespace ACLs once ACLs exist.

### Phase 3: memory append

- Add `/kb/assistant-memory` or `/assistant/memory` service.
- Add `agor_assistant_memory_append` and `agor_assistant_memory_search` MCP tools.
- Server creates `memory/YYYY-MM-DD.md` docs and appends deterministic blocks.
- Use existing document versioning/search units initially, even if embeddings are not yet optimized.

### Phase 4: deterministic unit reuse

- Add memory-block chunker.
- Add reusable unit identity / embedding reuse strategy.
- Ensure reindex only queues new or changed memory blocks.
- Add tests proving appending entry N+1 does not enqueue embeddings for entries 1..N.

### Phase 5: migration/export UI

- Assistant settings: show namespace, privacy policy, import/export status.
- One-click import from assistant worktree memory files to KB.
- Optional materialize/export for local framework backup.
- Knowledge page filters/views for Assistant namespaces and Memories.

### Phase 6: ACLs and sharing

- Add namespace/document ACLs or branch-seeded KB memberships. This is likely required to support Assistant Knowledge explicit namespace grants without making documents public.
- Model team/shared assistants without making personal memories public.
- Add audit/reporting for assistant KB writes.

## Open questions

1. Is “assistant” ready to become a first-class DB entity, or should it remain branch metadata for now? This design assumes branch metadata for smallest PR.
2. What exact policy names should assistant KB use: `private`, `branch`, `team`, `public`, or a dedicated read/write scope vocabulary?
3. Should assistant sessions write memory as the session creator, the assistant owner, or a future assistant principal/service identity?
4. What is the minimal namespace ACL model: namespace members with `read`/`write`/`manage`, document ACLs, or both?
5. Should `SOUL.md`/`USER.md` be imported into KB automatically, or only after explicit user confirmation because of sensitivity?
6. What is the right UI home: Knowledge page filtered by namespace, Assistant settings tab, or both?
7. How much filesystem materialization is needed for non-Agor agents and local IDE workflows?
8. Should memory append accept only one bullet by design, or also allow batch append for heartbeat summaries?
9. Should graph links to sessions/tasks/branches be explicit metadata only in V1, or rendered into markdown as `agor://` URIs?
10. How should assistant namespace backup/export interact with git backup of the assistant branch?
11. Should generic `agor_kb_*` tools be policy-aware when called from an assistant session, or should enforcement live only in `agor_assistant_*` tools?

## Bottom line

Make KB the assistant's managed memory substrate, not just a place where agents manually edit markdown. Assign each assistant a private operational namespace, expose context-aware assistant MCP tools, keep generic KB tools for deliberate cross-namespace work, and migrate the file framework gradually so local/file workflows continue to work. Seed KB permissions from branch/assistant ownership, but let KB have its own ACLs and search semantics. The first useful slice is namespace provisioning plus `agor_assistant_context`; the highest-leverage follow-up is an Assistant Knowledge settings tab and deterministic `agor_assistant_memory_append`.
