# Knowledge Namespace RBAC V1

**Date:** 2026-06-07  
**Scope:** Directed V1 design/implementation plan for Knowledge namespace RBAC and Assistant home namespaces.

## Recommendation

Build V1 around **Knowledge namespaces as the RBAC boundary**.

Do **not** make assistants first-class KB ACL subjects in V1. Do **not** add per-document ACLs in V1. Do **not** implement assistant-vs-user permission intersections in V1 beyond the existing fact that every session already runs as a concrete user.

Instead:

1. Add namespace-level permissions for **users and groups**.
2. Give each namespace an `others_can` fallback for everyone else in the workspace: `none | read | write`.
3. Keep document-level `visibility` / `edit_policy` as a narrower document-level overlay for now.
4. Add **Knowledge -> Settings -> Namespaces** CRUD and permission UI.
5. Add **BranchModal -> Knowledge** for assistant branches, with a configurable **home namespace**.
6. Treat assistant-specific namespace access restrictions as future work.

This keeps the V1 mental model simple:

```text
Can this user access this namespace?
  yes -> apply document visibility/edit policy
  no  -> no KB access
```

For assistant sessions, the operating user already exists. In V1, assistants borrow that user's KB permissions, and the assistant's home namespace is a default operating location, not a separate security principal.

## Goals

- Make KB namespace ownership and sharing explicit.
- Support private/team/shared KB spaces without relying on doc-level `public/private` alone.
- Make namespace management visible in the product UI.
- Give every assistant a clear home namespace for memory/docs/skills.
- Avoid a complex dual-principal user+assistant RBAC model in V1.
- Avoid “RBAC on RBAC” and nested authority debates.

## Non-goals for V1

- Assistants as namespace ACL subjects.
- Mixed groups containing assistants.
- Assistant-specific read/write restrictions outside home namespace.
- Per-document ACL overrides beyond the existing document fields.
- Branch/worktree RBAC changes.
- Namespace permission inheritance from arbitrary org structures.

## Current state

Current KB permissions are document-centric:

- `kb_namespaces` has identity/metadata fields (`slug`, `display_name`, `description`, `kind`, `owner_user_id`, `repo_id`, `branch_id`, `visibility_default`) but no real ACL table.
- `kb_documents.visibility` is `public | private`.
- `kb_documents.edit_policy` is `owner | public | admins`.
- Services generally allow reads when a document is public, the caller is admin, or the caller created it.
- Services generally allow edits when caller is admin, creator, or the document is public-editable.
- Search similarly scopes by document visibility/creator/admin.

This is not enough to model “private namespace readable/writable by this group.”

## Namespace permission model

### Namespace fields

Add an `others_can`-style permission to namespaces:

```ts
type KnowledgeNamespaceOthersCan = 'none' | 'read' | 'write';
```

Suggested namespace additions:

```ts
interface KnowledgeNamespace {
  // existing fields...
  others_can: 'none' | 'read' | 'write';
}
```

Semantics:

| Level   | Meaning                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------- |
| `none`  | Users not named in ACL cannot read/search/write namespace docs.                                 |
| `read`  | Everyone in the workspace can read/search namespace docs, subject to doc visibility.            |
| `write` | Everyone in the workspace can read/search and write namespace docs, subject to doc edit policy. |

`write` implies `read`. `own` is not available as an `others_can` value.

### Namespace ACL entries

Add a namespace ACL table for users and groups:

```ts
type KnowledgeNamespaceSubjectType = 'user' | 'group';
type KnowledgeNamespacePermission = 'read' | 'write' | 'own';

interface KnowledgeNamespaceAclEntry {
  namespace_acl_id: UUID;
  namespace_id: KnowledgeNamespaceID;
  subject_type: KnowledgeNamespaceSubjectType;
  subject_id: UserID | GroupID;
  permission: KnowledgeNamespacePermission;
  created_by?: UserID | null;
  created_at: Date;
  updated_at?: Date | null;
}
```

Permission semantics:

| Permission | Meaning                                                               |
| ---------- | --------------------------------------------------------------------- |
| `read`     | List/search/get public docs in the namespace.                         |
| `write`    | Read plus create/update/archive docs allowed by document edit policy. |
| `own`      | Write plus manage namespace metadata and namespace ACLs.              |

`own` implies `write`; `write` implies `read`.

### Effective namespace permission

For a given user:

```text
effective_namespace_permission = max(
  direct user ACL,
  ACLs from groups containing user,
  namespace.others_can,
  admin override
)
```

Admins/superadmins retain manage access.

### Groups

V1 should reuse or extend existing user groups only if they are already a workspace-level user collection. Groups remain **user groups** in V1.

Do not add assistants to groups in V1. If future KB-specific mixed groups are needed, add them intentionally rather than expanding every product's group semantics implicitly.

## Document permissions under namespace RBAC

Namespace RBAC is the outer gate. Existing document fields remain a narrower overlay.

### Read

A user can read a document when:

1. User has namespace `read` or higher; and
2. Document is readable by existing document rule:
   - `visibility = public`, or
   - caller created it, or
   - caller is admin.

This preserves current private-document semantics.

Product note: in a private/team namespace, most shared docs should use `visibility = public`; the namespace ACL is what makes the doc non-public to the broader workspace. The word `public` becomes “public within this namespace's allowed audience,” not necessarily internet/workspace public.

Possible future cleanup: rename document `visibility` to something less globally loaded, such as `scope = namespace | owner`, but do not do that in V1.

### Write

A user can write a document when:

1. User has namespace `write` or `own`; and
2. Existing document edit rule permits the write:
   - caller created it, or
   - caller is admin, or
   - document is namespace-public-editable (`visibility = public` and `edit_policy = public`).

Interpret `edit_policy = public` as “editable by namespace writers,” not literally any authenticated user, once namespace RBAC exists.

### Manage namespace

A user can manage namespace settings and permissions when:

- user has namespace `own`, or
- user is admin/superadmin.

Namespace creator should receive `own` automatically.

## UI: Knowledge -> Settings -> Namespaces

Add namespace CRUD under Knowledge settings.

### Namespace list

Show:

- Display name
- Slug
- Kind
- Description preview
- `others_can`
- Current user's effective permission
- Document count
- Updated time

Actions:

- Create namespace
- Edit namespace
- Archive namespace
- Open namespace

### Namespace editor

Two tabs:

#### General

- Name/display name
- Slug (immutable after create)
- Description as markdown
- Kind (`global`, `team`, `repo`, `branch`, etc.)
- Optional owner/repo/branch linkage where relevant
- Default document visibility/status/edit policy

#### Permissions

- `Everyone else in workspace`: `none | read | write`
- Accumulator of users and groups
- Each entry has permission: `read | write | own`
- Effective permission preview for current user

Validation:

- At least one owner/admin path must remain.
- Cannot remove your own last `own` path unless admin.
- `write` and `own` imply read in UI.

## UI: Assistant BranchModal -> Knowledge tab

For assistant branches, add a new `Knowledge` tab.

V1 fields:

- **Home namespace** selector/creator.
- Namespace display summary: slug, visibility/defaults, current user's permission.
- Link to open namespace in Knowledge.
- Link to edit namespace permissions if user has `own`.
- Explanatory note:
  > This assistant uses its home namespace as the default place for memory, docs, skills, and prompts. In V1, assistant sessions use the operating user's Knowledge permissions. Future versions may allow assistant-specific namespace restrictions.

Behavior:

- On assistant creation, create a home namespace by default.
- Store home namespace on `branch.custom_context.assistant.kb`.
- Assistant-aware tools use home namespace as default destination.
- Generic KB tools remain namespace-explicit.

### Assistant home namespace defaults

Default slug:

```text
assistant-<branch-short-id>
```

Default display name:

```text
<Assistant display name> Knowledge
```

Default permissions should be conservative:

- `others_can = none`
- assistant branch creator/owner gets namespace `own`
- optionally seed branch owners as namespace `own` when branch RBAC is enabled

Do not attempt to mirror branch `others_can` automatically in V1. Provide explicit UI to change namespace permissions.

## Services/API changes

### Core types

Update `packages/core/src/types/knowledge.ts`:

- Add `KnowledgeNamespaceOthersCan`.
- Add `KnowledgeNamespacePermission`.
- Add `KnowledgeNamespaceAclEntry`.
- Add optional namespace permission summaries for API/UI.

### Database

Add migrations for sqlite/postgres:

- `kb_namespaces.others_can` defaulting to `read` or `write` for existing global-like namespaces, but `none` for newly created assistant namespaces.
- `kb_namespace_acl` table.
- Indexes on `(namespace_id)`, `(subject_type, subject_id)`, and unique `(namespace_id, subject_type, subject_id)`.

Migration question: what should existing namespaces default to? To preserve current open-ish behavior, `global` may need `others_can = read` or `write` depending on how much public-edit behavior exists. New assistant namespaces should default to `none`.

### Repositories

Add repository methods:

- `listNamespaceAcl(namespaceId)`
- `upsertNamespaceAclEntry(namespaceId, subjectType, subjectId, permission)`
- `removeNamespaceAclEntry(namespaceId, subjectType, subjectId)`
- `resolveNamespacePermission(namespaceId, userId)`
- `findReadableNamespaceIds(userId)` or query helper for search

### Services

Update KB services to enforce namespace permission:

- `kb/namespaces`
  - create: creator gets `own`
  - patch/update/remove: require `own` or admin
  - find/get: return namespaces caller can read/manage, plus permission summaries
- `kb/documents`
  - create: require namespace `write`
  - get/find: require namespace `read` plus doc visibility
  - patch/update/remove: require namespace `write` plus doc edit policy
- `kb/search`
  - filter by namespaces user can read
- `kb/graph`
  - only include nodes/edges for readable documents/namespaces
- `kb/document-edits`
  - require namespace `write` plus doc edit policy

### MCP tools

Existing tools should continue to work but respect namespace RBAC:

- `agor_kb_namespaces_list`: list readable namespaces and effective permission.
- `agor_kb_namespace_put`: create/update when permitted.
- `agor_kb_put`, `agor_kb_edit`, `agor_kb_publish_from_worktree`: require namespace write.
- `agor_kb_search`: search all readable namespaces by default.

Add or extend tools for namespace permissions only if useful for agents/admins:

- `agor_kb_namespace_acl_get`
- `agor_kb_namespace_acl_set`

These should require namespace `own` or admin.

## Search behavior

Default KB search should search **everything the current user can read**.

Filters:

- namespace slug/id
- path prefix
- kind/status/visibility
- mode text/semantic/hybrid

Search must apply namespace permissions before document visibility.

For assistant sessions in V1, search is still user-scoped because assistant-specific restrictions are future work. Assistant-aware search tools can default to the assistant's home namespace first, but they should not introduce a separate security model yet.

## Implementation phases

### Phase 1: namespace RBAC data model

- Add types.
- Add schema/migrations.
- Add repository helpers.
- Add tests for permission resolution.

### Phase 2: service enforcement

- Enforce namespace read/write/own in `kb/namespaces`, `kb/documents`, `kb/search`, `kb/graph`, and `kb/document-edits`.
- Preserve current document visibility/edit-policy behavior as an overlay.
- Add tests for namespace ACL + document visibility combinations.

### Phase 3: Knowledge settings UI

- Add Namespaces CRUD under Knowledge settings.
- Add General and Permissions tabs.
- Add users/groups accumulator with read/write/own.
- Add effective permission display.

### Phase 4: Assistant home namespace

- Extend `AssistantConfig` with optional KB home namespace metadata.
- Create default home namespace on assistant creation.
- Add BranchModal Assistant `Knowledge` tab.
- Make assistant-aware prompts/tools use home namespace as default.

### Phase 5: docs and migration polish

- Update user-facing docs for Knowledge namespaces and assistant home namespaces.
- Add migration notes for existing public/private docs.
- Add admin guidance for choosing `others_can` defaults.

## Future work

- Assistant principals in namespace ACLs.
- Mixed groups containing users and assistants.
- Assistant-specific namespace access restrictions.
- Per-document ACL overrides or deviations from namespace inheritance.
- Better terminology for document `visibility = public` inside restricted namespaces.
- Namespace templates/presets: personal, team, assistant-private, docs-public.

## Open questions

1. Should existing `global` default to `others_can = read` or `write` during migration?
2. Should namespace `write` bypass document `created_by` for non-public-edit docs, or should document edit policy stay as a second gate? Recommendation: keep second gate in V1.
3. Should group management remain global Settings -> Groups, or should KB namespace permissions have an inline lightweight group creation flow?
4. Should assistant home namespace be mandatory for assistant branches, or lazily created on first KB use?
5. Should namespace owners be separate ACL entries, or should `owner_user_id` continue to have special meaning? Recommendation: use ACL entries for actual authority; keep `owner_user_id` as metadata/back-compat.
6. Should namespaces have markdown descriptions rendered in the Knowledge UI home view?
7. What is the best UI location for Knowledge Settings: top-level Settings tab, Knowledge page settings drawer, or both?

## Bottom line

V1 should make **Knowledge namespace RBAC** real and visible. Users and groups get read/write/own on namespaces; everyone else gets a simple `none/read/write` fallback. Assistants get a home namespace in BranchModal, but assistant-specific access constraints stay future work. This is enough to make KB sharing understandable without introducing a dual user+assistant RBAC model too early.
