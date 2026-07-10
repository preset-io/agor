# Teammate KB namespace memory plan

**Date:** 2026-06-08
**Scope:** Concise implementation plan for using Agor Knowledge Base namespaces as the backend for Agor Teammates' memory, scratchpad, docs, skills, and file-like storage. This is a planning doc; do not implement from here without a follow-up task.

## Current state inspected

- PR #1382 is merged at `b38fe21a` and added namespace RBAC plumbing: `kb_namespaces.others_can`, `kb_namespace_acl`, permission resolution, Knowledge namespace Settings UI, and read/write/own enforcement across namespace, document, edit, version, search, and graph services.
- Existing teammate identity is branch-backed: `TeammateConfig` lives under `branch.custom_context.teammate`; `isTeammate()` gates teammate behavior.
- Teammate creation currently happens in UI flows (`createTeammateBranch`, onboarding) by creating a normal branch with teammate metadata, then starting a bootstrap session.
- Knowledge namespaces already support `kind`, `branch_id`, `repo_id`, `owner_user_id`, defaults, metadata, and slug-addressed document URIs.
- Existing KB MCP tools are explicit/global (`agor_kb_put`, `agor_kb_edit`, `agor_kb_search`, etc.) and already receive `McpContext` with `userId`, optional `sessionId`, and Feathers service params.

## Recommendation summary

1. Give every teammate branch a **primary KB namespace during teammate creation**; keep lazy repair only for legacy teammates or failed partial setup.
2. Store the binding in `branch.custom_context.teammate.kb` and mirror it on the namespace row (`kind: "branch"`, `branch_id`, `metadata.teammate = true`).
3. Add a **BranchModal -> Knowledge** tab for teammate branches that shows the primary namespace and an accumulator of additional namespace grants: `none | read | write`.
4. Make this configuration **API/UI-only, never MCP-mutatable**; teammate MCP tools may read effective context but must not create/edit the grant list or change the primary namespace.
5. Add teammate-specific MCP/API tools that infer current session -> branch -> teammate namespace, instead of asking agents to pass namespace slugs.
6. Keep existing generic KB tools explicit and admin/global-capable; add optional context defaults but do not silently rewrite namespaces.
7. Use append-only daily memory docs with deterministic entry blocks so only new/changed chunks need embeddings.

## Settled decisions for first build

- Teammate creation fails hard if namespace setup fails; let the error bubble.
- Missing namespace remains an allowed undefined state for legacy/failed setup; tools fail with `namespace for this agent is not set up`.
- Teammate namespaces and teammate-specific Knowledge search are open by default: `others_can: write`, public document default, `global_access: write`. Owners can narrow later.
- Store teammate KB config/grants as a blob in `branch.custom_context.teammate.kb` for the first build.
- Memory path default is `memory/YYYY-MM-DD.md`.
- Branch owners/admins can edit teammate KB config through API/UI; MCP cannot mutate it.

## 1. First-boot namespace setup

### Where to create or assign the namespace

Use a server-side helper, not prompt instructions, as the source of truth:

```ts
ensureTeammateKnowledgeNamespace(branchId, userId): Promise<{ namespace, branch }>
```

Call it from two places, with creation as the required path:

1. **Teammate creation path (required):** after the teammate branch row exists and before starting the bootstrap session. This covers `createTeammateBranch` and onboarding. If namespace setup fails, fail hard: raise the error and let it bubble through the teammate creation flow.
2. **No lazy repair:** an undefined/missing namespace is a valid persisted state for legacy or failed setup. Read/write teammate tools that require it should fail with the exact actionable error: `namespace for this agent is not set up`.

The helper should be idempotent:

- If `branch.custom_context.teammate.kb.primary_namespace_id` resolves to an active namespace, return it.
- Else find an active namespace with `branch_id = branch.branch_id` and `metadata.teammate.primary = true`.
- Else create one with defaults below and patch the branch custom context.

### Namespace defaults

- Slug: `teammate-<branchShortId>`; if taken, suffix `-2`, `-3`, etc. Keep slug stable and use display name for human labels.
- `display_name`: `<Teammate display name> Memory`.
- `kind`: `branch`.
- `branch_id`: teammate branch ID.
- `repo_id`: branch repo ID.
- `owner_user_id` / `created_by`: teammate branch creator or effective creator.
- `visibility_default`: `public`.
- `others_can`: `write` so the default matches Agor's open collaboration model: agents can see and write to each other's teammate namespaces unless an owner narrows access.
- Initial ACL: creator gets `own`; branch owners can configure teammate KB binding/grants.
- Metadata:

```ts
{
  teammate: {
    primary: true,
    branch_id,
    memory_path_template: "memory/{{YYYY-MM-DD}}.md",
    docs_root: "docs/",
    scratchpad_root: "scratchpad/",
    skills_root: "skills/"
  }
}
```

### Branch association shape

Extend `TeammateConfig` with a typed optional KB subobject:

```ts
interface TeammateKnowledgeConfig {
  primary_namespace_id: KnowledgeNamespaceID;
  primary_namespace_slug: string;
  memory_path_template: 'memory/{{YYYY-MM-DD}}.md';
  default_visibility: 'public' | 'private';
  grants?: Array<{
    namespace_id: KnowledgeNamespaceID;
    namespace_slug: string;
    access: 'none' | 'read' | 'write';
  }>;
}
```

V1 can keep this in `custom_context` to avoid a migration. If the tab grows, normalize to a `branch_knowledge_namespace_grants` table.

### BranchModal -> Knowledge tab

Show for teammate branches first; later it can apply to any branch.

Fields/actions:

- Primary namespace summary: display name, slug, effective user permission, visibility default, document count, link to open in Knowledge.
- "Create/repair namespace" action if missing or archived.
- "Change primary namespace" selector, gated by branch-owner/admin permission. This is a UI/API operation, not an MCP tool operation.
- Additional namespace access accumulator:
  - namespace selector
  - access: `none | read | write`
  - effective permission preview for the current user
- Shortcut to Knowledge namespace Settings for ACL edits when the user has `own`.
- Help text: teammate tools use the primary namespace by default; generic KB tools remain explicit.
- Security note: MCP can expose read-only teammate Knowledge context, but must not expose tools that patch `branch.custom_context.teammate.kb`, change the primary namespace, or add grants. Those mutations must go through authenticated REST/Feathers APIs used by the UI/CLI, where normal human/admin authorization and audit semantics apply.

## 2. Teammate-focused memory tool

Prefer product-facing names:

- `agor_teammate_context` (read-only)
- `agor_teammate_memory_append` (mutating)
- Optional alias later: `agor_teammate_memory_file` if product language lands on "file".

### `agor_teammate_memory_append`

Input:

```ts
{
  bullets: string | string[];
  date?: string; // YYYY-MM-DD; default server date
  category?: "note" | "decision" | "preference" | "project" | "learning" | "task" | "other";
  tags?: string[];
  importance?: "low" | "normal" | "high";
  source?: { sessionId?: string; taskId?: string; branchId?: string; uri?: string };
  idempotencyKey?: string;
}
```

Resolution:

1. Require MCP session context; otherwise return the existing session-context help pattern.
2. Load current session, then branch.
3. Require `isTeammate(branch)`; otherwise say this tool only works from a teammate branch/session.
4. Resolve the teammate primary namespace. Do not create or reconfigure it from this mutating memory tool. If missing, fail with `namespace for this agent is not set up`.
5. Check branch policy grant for the namespace is `write` and user's KB permission is `write` or `own`.
6. Append to `memory/YYYY-MM-DD.md` by default.

Helpful failure examples:

- `namespace for this agent is not set up`
- `You don't have write access to namespace teammate-03b62447. Ask a namespace owner to grant write access in Knowledge -> Settings -> Namespaces.`

### Deterministic append and chunking

Daily memory docs should be append-only markdown with stable blocks:

```md
# 2026-06-08

<!-- agor-memory-entry id="<uuid-or-idempotency-hash>" hash="sha256:..." -->

- [2026-06-08T15:20:00Z] note: Memory text here. #tag
  - source: agor://session/<id>
  <!-- /agor-memory-entry -->
```

Implementation notes:

- Normalize bullets, trim blanks, and generate one block per bullet.
- If `idempotencyKey` or normalized block hash already appears, skip that block and return `deduped: true` for it.
- Use a repository/service append helper rather than asking the model to generate `KnowledgeEditOp[]`.
- Preserve one KB version per append call, not one version per bullet.
- Follow-up: teach `knowledgeUnitsForMarkdown` to split on `agor-memory-entry` comments before heading/auto-split fallback, and reuse unit `content_md5`/embedding hashes so unchanged entries do not re-embed.

## 3. Namespace access model

### Product model

- Each teammate branch has exactly one **primary namespace**.
- BranchModal Knowledge tab manages an teammate policy grant list over namespaces.
- Effective teammate access is:

```text
teammate_branch_grant(namespace) ∩ effective_user_namespace_permission(namespace)
```

The teammate is not a separate KB principal in V1. It runs as a real Agor user/session, then the teammate branch grant list narrows where teammate-specific tools can read/write. Crucially, the teammate cannot edit that grant list through MCP; otherwise it could grant itself write access to new namespaces and elevate its own effective scope.

### Defaults

- Primary teammate namespace: open by default (`others_can: write`, docs `visibility: public` by default), matching Agor's default collaboration model.
- Additional namespaces: teammate-specific tools have write fallback by default through `global_access: write`, still intersected with the current user's normal KB permissions. Per-namespace overrides can narrow access to `none` or `read`.
- Owners can narrow namespace access later in Knowledge settings and BranchModal -> Knowledge.

### Accumulator/list

V1 storage options:

1. **Small first PR:** store grants in `branch.custom_context.teammate.kb.grants`.
2. **Follow-up if needed:** add `branch_knowledge_namespace_grants` with:
   - `branch_id`
   - `namespace_id`
   - `access: none | read | write`
   - `is_primary`
   - audit fields

- Do not overload `kb_namespace_acl` with branch subjects in V1. PR #1382 intentionally models namespace ACL subjects as users/groups.
- Do not register MCP tools that mutate this accumulator. Branch/teammate Knowledge policy is controlled by UI/API-only services, not by the teammate's own tool surface.

## 4. Existing KB tools/API context behavior

### Generic KB tools

Keep generic tools backward-compatible:

- `agor_kb_put`, `agor_kb_edit`, `agor_kb_get`, `agor_kb_search` continue accepting explicit `namespace`/`uri`.
- Do not force the teammate namespace for generic tools.
- Improve error text by including namespace slug and required permission when the service can identify it.
- Optional later: if no namespace is supplied and MCP has a current teammate context, generic tools may suggest `Use agor_teammate_memory_append or pass namespace: <primarySlug>` rather than guessing.

### Teammate-aware wrappers

Add wrappers that are context-aware and bounded:

- `agor_teammate_kb_search`: default search scopes are primary namespace plus branch-granted read namespaces. Accept optional `includeShared: boolean` or explicit `namespaces`, but reject any namespace outside the grant list.
- `agor_teammate_memory_search`: hard-default `kind: memory`, `pathPrefix: memory/`, primary namespace.
- `agor_teammate_memory_append`: write only to primary namespace unless a future `target` is explicitly allowed.
- `agor_teammate_context`: read-only; may return primary namespace and grants, but must not accept mutation arguments.

Explicit non-goal for MCP: no `agor_teammate_namespace_set`, no `agor_teammate_grant_put`, and no generic MCP path that patches `custom_context.teammate.kb`. If MCP needs repair diagnostics, return instructions for a human/API caller instead of performing the mutation.

### Context resolver

Create a shared daemon helper for MCP/services:

```ts
resolveTeammateKnowledgeContext(ctx): {
  session;
  branch;
  teammateConfig;
  primaryNamespace;
  grants;
  effectiveUserPermission;
}
```

Use existing `ctx.sessionId`, `sessions.get`, `branches.get`, and `KnowledgeNamespaceRepository.resolveNamespacePermission`.

## 5. Data model, migrations, services

### Smallest viable data changes

No required migration for the first PR if we use:

- `branch.custom_context.teammate.kb` for the branch binding/policy.
- Existing `kb_namespaces.branch_id`, `kind`, `metadata`, `visibility_default`, `others_can` for namespace metadata.
- Existing `kb_namespace_acl` for user/group security.

Type changes still needed:

- Add `TeammateKnowledgeConfig` to `packages/core/src/types/branch.ts` and include `kb?: TeammateKnowledgeConfig` in `TeammateConfig`.
- Add tests for `getTeammateConfig` preserving `kb` metadata.

### Services/helpers likely needed

- New helper module near branches/knowledge services: `teammate-knowledge.ts`.
- API-only custom methods for configuration, e.g. `/branches/:id/teammate-knowledge` or `/teammate/knowledge/config`, used by UI/CLI and protected by branch-owner/admin checks. Do not expose these as MCP tools.
- Optional read-only Feathers/service method for context: `/teammate/knowledge/context` or `/kb/teammate-context`.
- MCP registrations in a new `apps/agor-daemon/src/mcp/tools/teammate-knowledge.ts` or in `knowledge.ts` if kept small; MCP registrations should be read/append/search only, not configuration mutation.
- BranchModal Knowledge tab UI slice and client calls to `kb/namespaces`/`kb/documents` plus the API-only teammate Knowledge config method.

### Follow-up normalized table

If custom context becomes hard to query or audit, add `branch_knowledge_namespace_grants` rather than changing PR #1382 ACL semantics. This table is an teammate/branch **policy allowlist**, not the KB security ACL itself.

## 6. Phased implementation plan

### PR 1: foundation and visible binding

- Add typed `TeammateKnowledgeConfig`.
- Add idempotent `ensureTeammateKnowledgeNamespace` helper.
- Invoke it from teammate creation before the bootstrap session starts; use `agor_teammate_context` only for read/diagnostic legacy missing-namespace reporting.
- Add BranchModal -> Knowledge tab that can display/create/repair/select the primary namespace via API/UI-only calls.
- Store binding in `branch.custom_context.teammate.kb` and mirror on namespace metadata.
- Tests:
  - helper creates an open namespace (`others_can: write`, `visibility_default: public`) with creator `own` ACL
  - helper is idempotent
  - namespace setup failure during teammate creation bubbles as a hard failure
  - existing teammate without binding is left undefined and MCP tools fail with `namespace for this agent is not set up`
  - MCP cannot mutate teammate KB config or grant itself namespace access
  - BranchModal tab renders missing/configured namespace states

### PR 2: memory append tool

- Add `agor_teammate_memory_append` and `agor_teammate_memory_search`.
- Implement deterministic append blocks, idempotency, and helpful permission errors.
- Use existing KB document write/version/indexing path.
- Tests:
  - requires session context
  - rejects non-teammate branches
  - rejects missing namespace with `namespace for this agent is not set up`
  - rejects no write access
  - appends multiple bullets into one version
  - duplicate idempotency key/hash does not duplicate content

### PR 3: branch namespace grant accumulator

- Add BranchModal Knowledge grants list over namespaces.
- Initially store in `custom_context.teammate.kb.grants`.
- Add `agor_teammate_kb_search` bounded by grants.
- Tests for read/write narrowing as intersection with user KB ACL.

### PR 4: chunk reuse and optional normalization

- Split memory docs into units by `agor-memory-entry` blocks.
- Reuse unchanged unit hashes/embeddings across versions.
- Consider `branch_knowledge_namespace_grants` migration if queries/UI need stronger auditability.

## Open design questions

- Should BranchModal Knowledge appear for all branches after teammate V1, making branch namespaces a general feature?
- Should "scratchpad" be KB documents under `scratchpad/` or remain temporary filesystem state with optional publish-to-KB?
