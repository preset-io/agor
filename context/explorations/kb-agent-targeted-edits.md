# Knowledge Base Agent Targeted Edits

**Status:** 🔬 Exploration / design.
**Created:** 2026-06-06
**Scope:** DB-backed Knowledge documents and agent/MCP editing workflows. This is not an implementation plan for artifacts generally, but it borrows lessons from the artifact land/publish round trip.

---

## TL;DR

**Recommendation: make remote, version-checked targeted edits the canonical KB editing path, and treat filesystem materialization as an optional workspace/export convenience.**

For agents, the smallest clean product should be:

1. Read a cheap structural view of a document: outline + line ranges + current version/ETag.
2. Read a focused range or heading section, not the whole article.
3. Submit **all desired edits as one `KnowledgeEditOp[]` batch** against an explicit base version.
4. Let the server apply the batch to the current stored markdown, create **one** normal immutable KB version, reindex/search-sync, update graph references, and return a preview/diff or committed version.

Filesystem round-tripping is still valuable, especially when an agent wants its normal file-edit tools. But it should be modeled as **materializing a KB snapshot into an Agor-managed workspace target** (branch/worktree, environment pod, or temp workspace), not as a generic assumption that the MCP server and client share a local filesystem.

Artifacts are important precedent: Agor already has MCP tools that read/write daemon-visible filesystem paths. That precedent makes a KB filesystem workflow reasonable in self-hosted/local mode, but it also points at a security pattern we should tighten and reuse: filesystem tools should be **branch-scoped and branch-relative** (`branchId` + `subpath`), with branch RBAC checks, instead of accepting arbitrary absolute paths.

---

## 1. Current state summary

### 1.1 Knowledge documents are DB-backed markdown with immutable versions

Code pointers:

- Types: `packages/core/src/types/knowledge.ts`
- Schemas: `packages/core/src/db/schema.sqlite.ts`, `packages/core/src/db/schema.postgres.ts`
- Repositories: `packages/core/src/db/repositories/knowledge.ts`
- Services: `apps/agor-daemon/src/services/knowledge-documents.ts`, `knowledge-versions.ts`, `knowledge-search.ts`, `knowledge-graph.ts`
- MCP tools: `apps/agor-daemon/src/mcp/tools/knowledge.ts`
- UI: `apps/agor-ui/src/pages/KnowledgePage.tsx`

The core document row (`kb_documents`) stores stable identity and governance: namespace/path/URI, title, kind, visibility, status, edit policy, owner/updater fields, archived state, and `current_version_id`.

The content itself lives in immutable `kb_document_versions` rows with `version_number`, `content_text`, content hashes, frontmatter, version metadata, change summary, creator, and timestamp.

Writes are already version-producing: `KnowledgeDocumentRepository.update()` inserts a new `kb_document_versions` row when `content_text` is supplied, then advances `kb_documents.current_version_id` in the same transaction.

### 1.2 Current agent edit surface is whole-document

The MCP Knowledge tools currently expose:

- `agor_kb_get`: reads a document by id/URI/namespace+path. It includes full markdown content by default.
- `agor_kb_put`: creates or updates a markdown document. The `content` input is the full markdown body for the new version.
- `agor_kb_history`: lists immutable versions; can include full historical content.
- `agor_kb_search`, namespace tools, and graph tools.

`agor_kb_put` has an `expectedVersion` optimistic concurrency argument, but the caller must still send the complete replacement content. For a large document where only one line changes, today an agent likely has to fetch the full document into context and post the full replacement back.

The UI follows the same model: `KnowledgePage.tsx` loads content for the active document and saves via `client.service('kb/documents').patch(activeDoc.document_id, { content_text: ... })`.

Markdown link extraction is intentionally KB-document-focused today. Links like
`agor://kb/document/<id>` or `agor://kb/<namespace>/<path>` create document
`references` edges on save. Links to other Agor object schemes such as
`agor://session/...` are not auto-extracted from markdown; agents should use
explicit `agor_kb_link` calls for session, board, artifact, external URL, or
other non-KB graph edges.

### 1.3 Internal KB units are not yet an editing API

`kb_document_units` already represent document/section/file/auto-split units used for search/indexing. The markdown chunking path can produce heading-aware units, and search results can include chunks/snippets.

However, these units are explicitly internal. They do not currently provide stable editable section IDs, and they are replaced on each version. They are useful as implementation support for outline/range reads, but should not be treated as durable user-facing edit targets without an explicit stability contract.

### 1.4 Artifact land/publish exists but is filesystem-coupled

Artifacts have a mature round-trip workflow:

- `agor_artifacts_publish(folderPath, ...)` reads a folder and stores a DB file map.
- `agor_artifacts_land(artifactId, branchId, subpath, overwrite)` writes stored files into a branch path, with branch permission checks and path containment.
- `ArtifactsService.land()` carefully prevents absolute paths, branch-root writes, destination escapes, and artifact file path escapes. It writes a sidecar (`agor.artifact.json`) so metadata survives round trips.

This is a useful precedent, but it also exposes the trap for KB and for artifacts themselves: some artifact tools accept daemon-local absolute paths and assume the daemon can read/write branch paths or temp dirs. That is acceptable for current self-hosted/local deployments only if scoped carefully. A remote MCP client cannot assume that `/tmp/foo.md` means the same machine, namespace, or permissions boundary as the daemon.

Security note: artifact landing already takes `branchId` and checks branch permission. Artifact publishing/checking from arbitrary absolute `folderPath` is more open: if a caller can point the daemon at a readable path inside some registered branch or temp directory, the tool may read/publish content without proving the caller has branch access. KB should not copy that shape. Longer-term, artifacts should align to the safer pattern too:

```ts
agor_artifacts_publish({
  branchId,
  subpath, // branch-relative folder path
  ...
})
```

The service can still support a legacy absolute `folderPath` escape hatch for local/self-hosted compatibility, but new MCP guidance should prefer `branchId + subpath`, branch containment, and branch RBAC.

### 1.5 Existing permissions are document-centric, not branch-centric

Knowledge document access today is handled in `KnowledgeDocumentsService`:

- Read if document is public, user is admin, or user is creator.
- Edit if user is admin, creator, or document is public with `edit_policy = public`.
- Governance changes (`visibility`, `status`, `edit_policy`) are owner/admin only.
- Drafts are not secret by status alone; browsing/search hide other users' drafts by default, while direct reads still use normal visibility checks.

Branch RBAC only applies indirectly today when a tool writes to a branch filesystem, e.g. artifact landing requires `session` permission or higher on the target branch.

---

## 2. Goals and non-goals

### Goals

- Let agents edit small parts of large KB markdown documents without loading full content into model context.
- Preserve the existing KB write lifecycle: immutable versions, hashes, search units, graph reference sync, realtime events, history UI.
- Make concurrency explicit and safe via version/ETag checks.
- Keep MCP tools usable from local and remote clients.
- Provide a path to normal file-edit workflows without baking in a shared-filesystem assumption.
- Keep V1 small enough to ship and review.

### Non-goals for the first PR

- Collaborative CRDT editing.
- A full markdown AST editor.
- Stable semantic section IDs across arbitrary heading renames.
- Git sync for KB documents.
- Replacing the current whole-document UI editor.
- Solving artifact filesystem decoupling broadly.

---

## 3. Recommended approach

### 3.1 Canonical path: DB-native targeted edits

Add a KB edit service/API that accepts a document reference, an expected base version, and one or more edit operations. The server reads the current version content internally, validates the base version, applies the operations, and writes a new ordinary KB version.

This keeps the source of truth in the KB database and avoids forcing the model to hold a full document. The server can still read the full content in memory; the constraint is model context, not daemon RAM.

Recommended V1 flow:

```text
agent
  -> agor_kb_outline(documentId)
     returns headings, line ranges, version id/number/hash

agent
  -> agor_kb_get_range(documentId, startLine, endLine, contextLines, version)
     returns only relevant lines + same version metadata

agent
  -> agor_kb_edit(documentId, expectedVersion, ops, dryRun=false, changeSummary)
     server applies the full ops[] batch atomically, creates one KB version, returns diff + new version
```

### 3.2 Optional path: workspace materialization

Support filesystem workflows as a second layer:

```text
agor_kb_materialize(documentRef, target={kind:"branch", branchId, subpath})
agent edits file using normal file tools
agor_kb_publish_from_workspace(materializationId or sourceRef, expectedVersion)
```

The important product distinction: this is not "write this file to my local disk." It is "materialize this KB snapshot into an Agor-managed workspace resource." The workspace may happen to be a local worktree in self-hosted mode, or it may be an executor/env pod volume in hosted mode.

If a non-Agor local MCP client wants to edit a local file, it should use download/upload semantics or targeted remote edit tools. It should not pass arbitrary local paths to the daemon and expect them to exist.

### 3.3 Why this recommendation

Remote targeted edits are the best default because they:

- Work for local and remote MCP clients.
- Reuse existing KB permissions and versioning.
- Avoid arbitrary daemon filesystem reads/writes.
- Are auditable as document edits, not opaque file syncs.
- Produce clean conflict errors before a write.
- Fit the current DB-backed KB design.

Materialization remains useful because agents are very good at file editing when the source is on disk. But making it optional avoids turning KB into a filesystem staging system by default.

---

## 4. Alternative designs and tradeoffs

### Option A — Whole-document get/put only

**Shape:** Keep `agor_kb_get` and `agor_kb_put` as the only content API.

**Pros**

- Already exists.
- Simple mental model.
- Existing versioning and graph sync work.

**Cons**

- Poor for large documents and small edits.
- High context cost and more opportunities for accidental unrelated changes.
- Hard for an agent to prove it only changed one line.

**Verdict:** Keep as escape hatch, but not sufficient.

### Option B — Filesystem-first KB editing

**Shape:** Add tools such as `land_markdown_in_my_worktree` and `publish_from_file_in_worktree`.

**Pros**

- Agents can use normal file-edit tools (`apply_patch`, editor buffers, grep, etc.).
- Familiar workflow for code-oriented agents.
- Easy to inspect in a branch before publishing.

**Cons**

- Ambiguous over MCP: whose filesystem is "my" worktree?
- Harder hosted story: daemon may not share FS with branch/env/executor.
- More RBAC layers: KB read/edit plus branch write plus Unix permissions.
- Publish must detect stale base version, moved/renamed docs, sidecar loss, and path spoofing.
- Creates an attractive nuisance: arbitrary path reads if modeled as `folderPath`/`filePath` too loosely.

**Verdict:** Useful as optional materialization into explicit Agor workspace targets. Not clean as the primary API. If implemented, the MCP shape should be branch-relative (`branchId` + `subpath`) and permission-checked, matching the artifact hardening direction.

### Option C — Many tiny remote edit tools

**Shape:** Expose separate tools: replace-in-document, insert-at-line, delete-line-range, replace-line-range, replace-heading-section, apply-unified-diff, etc.

**Pros**

- Easy for simple agents to discover a purpose-built tool.
- Deterministic line operations are straightforward to validate.
- Small inputs/outputs.

**Cons**

- Tool sprawl.
- Hard to compose atomically across multiple edits unless each tool grows batching semantics.
- Slightly different concurrency semantics per tool if not centralized.

**Verdict:** Avoid many top-level tools. Prefer one `agor_kb_edit` tool with a small set of operation types.

### Option D — Unified diff/patch only

**Shape:** Expose `agor_kb_apply_patch(document, expectedVersion, unifiedDiff)`.

**Pros**

- Very natural for coding agents.
- Can represent multiple hunks in one atomic edit.
- Server can return standard conflict/hunk failure diagnostics.

**Cons**

- Unified diff formatting is brittle across LLMs and libraries.
- Markdown headings/line numbers are easier for humans and simpler agents.
- Applying fuzzy patches can hide conflicts unless strict by default.

**Verdict:** Include as a supported operation, but not the only V1 path. Make it strict by default.

### Option E — Section-based AST edits

**Shape:** Expose edits by markdown heading path or stable section anchor.

**Pros**

- Better product semantics than line numbers.
- Resilient to unrelated edits above the target section if the heading is stable.
- Aligns with KB search units/chunking.

**Cons**

- Heading paths are not unique unless normalized and disambiguated.
- Heading rename/move semantics are hard.
- Requires a stable section identity contract if exposed broadly.

**Verdict:** Good Phase 2. In V1, expose outline/ranges and allow a convenience `replace_heading_section` only if it resolves to exactly one current range and still requires `expectedVersion` or `expectedSectionHash`.

---

## 5. Proposed API and MCP shape

### 5.1 Shared document reference

Reuse the existing MCP reference pattern:

```ts
type KnowledgeDocumentRef = {
  documentId?: string; // full UUID or short id
  uri?: string; // agor://kb/<namespace>/<path> or agor://kb/document/<id>
  namespace?: string;
  path?: string;
};
```

Prefer `documentId` or `agor://kb/document/<id>` for rename-proof edits.

### 5.2 Version / ETag vocabulary

Expose these consistently in read responses:

```ts
type KnowledgeVersionToken = {
  versionId: string;
  versionNumber: number;
  contentSha256: string | null;
  etag: string; // e.g. "kbv:<versionId>" or HTTP ETag header
};
```

For writes, require one of:

```ts
expectedVersion: string | number; // current existing style
// or
ifMatch: string; // ETag-style alias for HTTP clients
```

For MCP, keep `expectedVersion` to match `agor_kb_put`, and add `ifMatch` only if REST clients need direct ETag ergonomics.

### 5.3 `agor_kb_outline`

Read-only. Returns document metadata plus a markdown outline with line ranges.

```ts
agor_kb_outline({
  documentId?: string;
  uri?: string;
  namespace?: string;
  path?: string;
  version?: string | number;
  maxDepth?: number; // default 6
}) -> {
  document: KnowledgeDocument;
  version: KnowledgeVersionToken;
  lineCount: number;
  headings: Array<{
    level: number;
    title: string;
    headingPath: string;       // display/convenience, not a permanent id
    sectionRef: string;        // structural selector, e.g. "root.h1[1].h2[2]"
    occurrence: number;        // disambiguates duplicate heading paths
    startLine: number;         // 1-based inclusive
    endLine: number;           // 1-based inclusive section end
    contentStartLine: number;  // first line after heading
    chars: number;             // raw markdown chars in this section
    anchor?: string;
  }>;
}
```

`headingPath` is easy to read but collides when titles repeat and changes when titles are renamed. `occurrence` disambiguates duplicates. `sectionRef` is the preferred selector for agent follow-up reads: it is title-independent within a document version and therefore survives heading renames, but can still change when sections are inserted, deleted, or reordered. Keep outline metadata dense: line counts are inferable from `startLine`/`endLine`, and one `chars` hint is enough for agents to decide whether to read or page a section. Do not expose `kb_document_units.unit_id` as a stable edit id in V1.

### 5.4 `agor_kb_get_range`

Read-only. Returns a bounded slice of content by line range or heading.

```ts
agor_kb_get_range({
  documentId?: string;
  uri?: string;
  namespace?: string;
  path?: string;
  version?: string | number;

  startLine?: number;
  endLine?: number;

  headingPath?: string;
  occurrence?: number;
  sectionRef?: string; // preferred selector copied from agor_kb_outline

  contextLines?: number; // default 2, cap e.g. 20
  offsetLines?: number; // section/range-relative pagination offset
  maxLines?: number; // cap selected lines before adding context
  includeLineNumbers?: boolean; // default true
}) -> {
  document: KnowledgeDocument;
  version: KnowledgeVersionToken;
  lineCount: number;
  range: {
    startLine: number;
    endLine: number;
    contextStartLine: number;
    contextEndLine: number;
    sourceRange?: {           // present only when offsetLines/maxLines paged a larger selection
      startLine: number;
      endLine: number;
      omittedBefore: number;
      omittedAfter: number;
    };
    content: string;
    numberedContent?: string;
    contentMd5: string;
  };
}
```

Hard caps should prevent accidental full-document reads via a range tool. If the caller asks for too many lines, return a helpful error suggesting `agor_kb_get` for intentional full reads.

### 5.5 `agor_kb_edit`

Mutating. Applies one or more operations atomically to a document version. **One successful `agor_kb_edit` call creates one new `kb_document_versions` row.** The tool description should tell agents to batch related micro-edits into a single call: if the agent calls this tool 12 times, it will create 12 full-content versions and re-run version side effects 12 times.

```ts
agor_kb_edit({
  documentId?: string;
  uri?: string;
  namespace?: string;
  path?: string;

  expectedVersion: string | number; // required for content-changing commits
  dryRun?: boolean;                 // default false
  changeSummary?: string;
  metadata?: Record<string, unknown>;

  ops: KnowledgeEditOp[];

  returnContent?: 'none' | 'changed_ranges' | 'full'; // default changed_ranges
}) -> {
  dryRun: boolean;
  document: KnowledgeDocument;
  baseVersion: KnowledgeVersionToken;
  newVersion?: KnowledgeVersionToken;
  changedRanges: Array<{ startLine: number; endLine: number; content: string }>;
  diff: string;
  warnings: string[];
}
```

Recommended V1 operation set:

```ts
type KnowledgeEditOp =
  | {
      type: 'replace_line_range';
      startLine: number;
      endLine: number; // inclusive
      replacement: string;
      expectedText?: string; // exact guard against line drift
      expectedMd5?: string;
    }
  | {
      type: 'insert_at_line';
      line: number;
      position?: 'before' | 'after'; // default before
      content: string;
      expectedNeighborText?: string;
    }
  | {
      type: 'delete_line_range';
      startLine: number;
      endLine: number;
      expectedText?: string;
      expectedMd5?: string;
    }
  | {
      type: 'replace_literal';
      find: string;
      replace: string;
      expectedCount: number;
      scope?: EditScope;
    }
  | {
      type: 'apply_unified_diff';
      patch: string;
      strict?: boolean; // default true: no fuzzy hunk matching in V1
    };
```

Phase 2 operation:

```ts
| {
    type: 'replace_heading_section';
    headingPath: string;
    occurrence?: number;
    replacement: string;
    expectedSectionMd5?: string;
  }
```

Why this set:

- Line-range ops are deterministic, easy to explain, and small.
- `expectedText`/`expectedMd5` lets the agent prove it edited the intended slice.
- Literal find/replace is useful for repeated terminology/link fixes when guarded by `expectedCount` and optional scope.
- Unified diff covers advanced multi-hunk edits without many tool variants.
- A single `ops` array makes multi-edit commits atomic.

Regex replace should be a later operation, not V1 default:

```ts
| {
    type: 'replace_regex';
    pattern: string;
    flags?: string;
    replace: string;
    expectedCount: number;
    maxReplacements?: number;
    scope?: EditScope;
  }
```

Regex risks are mostly reliability and denial-of-service, not privilege escalation: catastrophic backtracking, excessive matches, hard-to-review replacement semantics, and implementation-dependent behavior. If added, use a safe regex engine such as RE2 where possible, cap pattern/replacement/input sizes, require `expectedCount` or `maxReplacements`, support scoping, and return a dry-run match preview.

### 5.6 REST / service shape

Prefer a first-class service over overloading `kb/documents.patch`:

```text
POST /kb/document-edits
```

Feathers service: `kb/document-edits` with `create(data, params)`.

Reasons:

- Keeps normal `kb/documents.patch` as metadata/whole-content patch.
- Gives hooks/audit/rate limits a clean resource name.
- Lets MCP and UI share exactly one backend path.
- Avoids adding many custom methods to `KnowledgeDocumentsService`.

The service should internally reuse Knowledge document permission checks and repository update behavior. If those helpers stay private, factor them into shared utilities rather than duplicating authorization logic.

### 5.7 Optional materialization tools

Do not name these as local-only filesystem tools. Use workspace language.

```ts
agor_kb_materialize({
  documentId?: string;
  uri?: string;
  namespace?: string;
  path?: string;
  version?: string | number;
  target: {
    kind: 'branch';
    branchId: string;
    subpath?: string; // branch-relative; default .agor/kb/<namespace>/<path>
  } | {
    kind: 'temp_workspace';
    ttlMinutes?: number;
  };
  overwrite?: boolean;
}) -> {
  materializationId: string;
  document: KnowledgeDocument;
  version: KnowledgeVersionToken;
  target: { kind: string; branchId?: string; path?: string; workspaceId?: string };
  instructions: string;
}
```

```ts
agor_kb_publish_from_workspace({
  materializationId?: string;
  source: {
    kind: 'branch';
    branchId: string;
    path: string; // branch-relative path
  } | {
    kind: 'temp_workspace';
    workspaceId: string;
    path?: string;
  };
  documentId?: string;
  expectedVersion?: string | number; // required unless sidecar supplies it
  changeSummary?: string;
  dryRun?: boolean;
}) -> { ...same as agor_kb_edit-ish result... }
```

The sidecar should include at least:

```json
{
  "$schema": "https://agor.live/schemas/kb-materialization/2026-06-06.json",
  "document_id": "...",
  "uri": "agor://kb/document/...",
  "namespace": "global",
  "path": "foo.md",
  "version_id": "...",
  "version_number": 12,
  "content_sha256": "...",
  "materialized_at": "...",
  "materialized_by": "..."
}
```

For hosted/remote execution, the write/read should happen through the executor or environment owner for that workspace. The daemon should not need direct access to branch files in the long-term architecture.

The same branch-relative shape should be the preferred future artifact API:

```ts
agor_artifacts_publish({
  branchId,
  subpath,
  artifactId?,
  ...
})
```

`agor_artifacts_land` is already close because it requires `branchId`; `agor_artifacts_publish` and `agor_artifacts_check_build` are the bigger alignment targets because they currently accept absolute folders.

---

## 6. Data, versioning, and concurrency model

### 6.1 Existing version table remains the source of truth

V1 does not need a schema change. A targeted edit ultimately produces a normal `kb_document_versions` row with complete `content_text`, hashes, frontmatter, version metadata, and change summary.

Store edit details in `version_metadata` initially:

```json
{
  "edit_source": "mcp:agor_kb_edit",
  "base_version_id": "...",
  "base_version_number": 11,
  "ops": [{ "type": "replace_line_range", "startLine": 42, "endLine": 44 }],
  "dry_run": false
}
```

Do not store full replacement snippets in metadata by default if they duplicate the version content. Keep metadata small and audit-oriented.

### 6.2 Future audit table

A later PR can add `kb_document_edit_events` if version metadata becomes insufficient:

```ts
interface KnowledgeDocumentEditEvent {
  edit_event_id: string;
  document_id: string;
  base_version_id: string;
  new_version_id?: string | null;
  actor_user_id?: string | null;
  session_id?: string | null;
  task_id?: string | null;
  tool_name: string;
  dry_run: boolean;
  ops_summary: unknown;
  diff_md5?: string | null;
  status: 'applied' | 'dry_run' | 'conflict' | 'failed';
  error?: string | null;
  created_at: Date;
}
```

This table becomes more important for personal API key MCP calls, where there may be no persisted task/message transcript to audit.

### 6.3 Optimistic concurrency

Rules:

- Mutating targeted edits require `expectedVersion` unless `dryRun=true` and explicitly allowed.
- The server resolves the current document and checks that current version id or number matches.
- If it does not match, return `409 Conflict` (or MCP error payload) with:
  - current version id/number/hash,
  - base version requested,
  - a hint to re-run `agor_kb_outline`/`agor_kb_get_range`,
  - optionally the current target range if the operation included line numbers and the range is safe to show.

Line operations also validate their own guards:

- `startLine`/`endLine` within current base content.
- `expectedText` exact match if supplied.
- `expectedMd5` exact match if supplied.
- Multiple ops are compiled against the same base content, then applied deterministically as a batch. V1 should reject overlapping ranges/matches. For line ops, either require non-overlapping sorted input or apply compiled spans from bottom-to-top to avoid line shifts. For find/replace ops, require `expectedCount` so broad accidental replacements fail closed.

### 6.4 Preview/dry-run

`dryRun=true` should perform the same permission, version, operation, markdown, and graph-link preview checks but not write a new version.

Return:

- unified diff,
- changed ranges,
- warnings,
- would-be title if `title_from_content` metadata is active,
- extracted KB links delta if feasible.

### 6.5 Markdown validity

Markdown is permissive, so "validity" should mean lightweight safety checks, not a full formal validation gate:

- Preserve line endings reasonably; normalize to `\n` unless existing content is CRLF and we decide to preserve it.
- Ensure content remains UTF-8 text.
- Keep existing path normalization rules for document identity.
- If frontmatter is supported in content later, parse frontmatter in preview and return warnings instead of silently corrupting it.
- Re-run existing link extraction and graph sync on commit.
- Re-run chunking/search unit replacement exactly as whole-document writes do.

---

## 7. Security, RBAC, and audit considerations

### 7.1 Document permissions

Targeted edits must use the same read/edit rules as whole-document edits:

- Read slices/outline only if `canRead(document, user)`.
- Commit edits only if `canEdit(document, user)`.
- Governance changes remain outside targeted edit ops and stay owner/admin only.

Do not let targeted edit tools mutate `visibility`, `status`, `edit_policy`, namespace, or path. Keep those on the existing document management surface.

### 7.2 Branch/workspace permissions

Materialization adds a second authorization layer:

- To materialize into a branch, caller must read the KB doc and have at least branch `session` permission (same threshold artifact land uses today) or a deliberately chosen stronger tier.
- To publish from a branch/workspace, caller must have KB edit permission and read access to the workspace file. If the source is a branch, they should also have at least branch `session` permission.
- In strict/insulated Unix modes, filesystem operations should execute as the same identity that owns the workspace/executor context, not as the daemon user.

### 7.3 Avoid arbitrary path APIs

Avoid MCP tools that accept daemon-local absolute paths unless the path is explicitly scoped by an Agor resource id.

Bad universal shape:

```ts
publish_from_file({ filePath: '/tmp/foo.md' });
```

Better shape:

```ts
publish_from_workspace({ source: { kind: 'branch', branchId, path: '.agor/kb/foo.md' } });
```

The second shape lets Agor validate branch RBAC, path containment, executor locality, and audit provenance.

This should become a shared filesystem-tool contract:

- New KB tools: require `branchId + branchRelativePath` for branch materialization/publish.
- New artifact tools: prefer `branchId + subpath` for publish/check/build workflows.
- Legacy artifact absolute paths: keep only as an explicit compatibility path if needed, and consider rejecting paths inside branches unless the caller has access to the matched branch.
- Temp directories: if supported, use Agor-created temp workspaces or per-call upload/materialization IDs, not arbitrary `/tmp` reads.

### 7.4 MCP local/remote model

MCP calls are authenticated HTTP requests to Agor. They may come from:

- an Agor-launched agent running in a branch worktree,
- a local desktop client on the same host as the daemon,
- a remote hosted agent,
- a third-party orchestrator with a personal API key.

Tool names and schemas should not imply a shared local filesystem. A returned `path` should be described as an Agor workspace path, not necessarily a path the MCP client can open locally.

### 7.5 Direct URL access

Direct document URLs already use `canRead` semantics. Targeted edit previews and materialized workspace files need equivalent care:

- A preview/diff response may include private document text and must require read permission.
- Materialized files in a branch inherit branch filesystem exposure. That means landing a private KB document into a shared branch can intentionally or accidentally broaden access. The tool should warn when `document.visibility = private` and the target branch is shared.
- Temp workspaces should have TTLs and owner-scoped access.

### 7.6 Audit trail

V1 audit sources:

- Existing immutable version history (`created_by`, `created_at`, `change_summary`, hashes).
- `updated_by`/`updated_at` on `kb_documents`.
- Version metadata with targeted edit source and base version.
- MCP/task transcripts when the edit happened inside an Agor session.

Recommended improvements:

- Include `ctx.sessionId` in edit metadata when present.
- Add a future edit-events table for conflict/dry-run/failed attempts and personal API key calls.
- Surface targeted edit summaries in the Knowledge history UI.

---

## 8. UI affordances

Small, useful UI pieces:

1. **History diff view**: show version-to-version markdown diff. This helps human review of targeted edits even before a richer preview flow.
2. **Conflict banner**: if a user is editing stale content, show current version changed and offer reload/diff.
3. **Agent edit preview modal**: for dry-run/proposed edits, show summary, changed ranges, and unified diff; allow owner to apply if permissions allow.
4. **Line numbers / copy range**: optionally show line numbers in read mode or expose "copy range reference" so humans can ask an agent to edit `global/foo.md lines 120-135`.
5. **Outline anchors**: headings in the viewer can expose stable-ish anchors and line ranges for agent prompts.
6. **Materialization warning**: when landing private KB into a shared branch, show/return a warning about branch exposure.

No need to build these in the first PR unless the backend needs a human tester.

---

## 9. Phased implementation plan

### Phase 0 — Refactor support only if needed

- Extract reusable document resolution and permission helpers from `KnowledgeDocumentsService` if the new edit service would otherwise duplicate private methods.
- Add a markdown line/outline utility with focused unit tests.

### Phase 1 — Smallest useful first PR

Ship remote targeted edits only:

1. Add core types for:
   - `KnowledgeVersionToken`
   - `KnowledgeDocumentOutline`
   - `KnowledgeDocumentRange`
   - `KnowledgeEditOp`
   - `KnowledgeEditResult`
2. Add `kb/document-edits` service with `create()` supporting:
   - `dryRun`
   - required `expectedVersion` for commits
   - `replace_line_range`
   - `insert_at_line`
   - `delete_line_range`
   - `replace_literal` with required `expectedCount`
   - non-overlap validation
   - version metadata carrying edit source/base/ops summary
3. Add read helpers, either as:
   - `kb/document-ranges` service, or
   - custom methods on documents service exposed through MCP only initially.
4. Add MCP tools:
   - `agor_kb_outline`
   - `agor_kb_get_range`
   - `agor_kb_edit`
5. Tests:
   - unit tests for line operation application,
   - service tests for permissions and version mismatch,
   - MCP tool tests for schema/argument mapping,
   - graph/search sync still runs because commit delegates to existing document update path.

This PR solves the core agent problem without filesystem complexity.

MCP copy should be explicit: one successful call creates one immutable KB version, so agents should collect related edits and send them as one `ops[]` batch rather than calling the tool repeatedly for micro-edits.

### Phase 1A — Artifact filesystem hardening / alignment

This can ship independently or as a small security-adjacent patch near the KB work:

- Add branch-relative variants to `agor_artifacts_publish` and `agor_artifacts_check_build`:
  - `branchId`
  - `subpath`
  - branch RBAC check (`session` or stronger)
  - path containment under the resolved branch root
- Keep `folderPath` temporarily for compatibility, but prefer/describe `branchId + subpath` in MCP docs.
- If `folderPath` resolves inside a known branch, require the caller to have access to that branch before reading.
- Consider replacing arbitrary temp-dir publishing with Agor-managed temp workspace IDs.

This aligns artifacts and KB on the same filesystem security contract and reduces the risk that a user can publish files from a branch or temp path they should not be able to read.

### Phase 2 — Unified diff and better previews

- Add `apply_unified_diff` op with strict hunk application.
- Add richer dry-run response with rendered diff and title/link deltas.
- UI history diff view.

### Phase 3 — Heading-section convenience

- Add `replace_heading_section` using outline resolution.
- Return duplicate-heading diagnostics and require `occurrence` when ambiguous.
- Consider stable generated section anchors if the product starts relying on section identities.

### Phase 4 — Workspace materialization

- Add `kb_materializations` concept or sidecar-only MVP.
- Materialize into branch target with `branchId + subpath`, branch RBAC, and path containment.
- Publish from branch target with `branchId + branch-relative path` and sidecar `expectedVersion`.
- Route filesystem operations through executor/workspace abstraction where available, instead of daemon-local FS.

### Phase 5 — Full audit and collaboration polish

- Add `kb_document_edit_events`.
- UI proposed-edit review queue.
- Optional locks/leases if humans and agents frequently collide on long edits.

---

## 10. Open questions

1. Should `expectedVersion` be mandatory for `dryRun`, or only for commits?
2. Should V1 line numbers be 1-based only? Recommendation: yes, and document it everywhere.
3. What is the maximum range size for `agor_kb_get_range` before the caller should use `agor_kb_get` intentionally?
4. Should `replace_line_range` preserve trailing newline exactly, or normalize all KB markdown to `\n`?
5. Is `branch session` permission sufficient for KB materialization, or should landing private docs require `prompt`/`all` or explicit branch owner confirmation?
6. Should public-edit KB documents allow any member to use targeted edits, or should MCP targeted edits require a stricter role than the UI? Recommendation: same as whole-document edit to avoid surprising policy divergence.
7. Do we need a separate `review/apply proposed edit` workflow before agents can commit to high-value namespaces?
8. Should search units become stable section references eventually, or should editable section IDs be a distinct table?
9. How much of the edit event audit belongs in version metadata versus a first-class table from day one?
10. For hosted deployments, what is the canonical "workspace" abstraction shared by branch files, terminals, artifacts, uploads, and KB materializations?

---

## 11. Summary recommendation

Build the KB editing API around **small remote reads + atomic version-checked edit operations**. It is the cleanest fit for Agor's DB-backed Knowledge model and works regardless of where the MCP client runs.

Then add filesystem materialization as an explicit Agor workspace feature, not as a generic local path feature. That keeps the excellent agent file-edit workflow available without compromising RBAC, auditability, or the hosted/remote architecture.

### Implementation notes — June 6, 2026

- `kb/document-edits` service applies `KnowledgeEditOp[]` sequentially and reuses `putDocument` so only one version is minted per successful call. Dry runs skip the commit and can optionally return the post-edit content via `returnContent:"full"`.
- The MCP tool `agor_kb_edit` surfaces the same guarantee and encourages batching to avoid version spam.
- Artifact publish/check now prefer `branchId + subpath` and enforce branch RBAC when paths resolve inside a registered worktree; legacy `folderPath` is still accepted but inherits the same permission gate. The service-level `branchId` path now requires a non-empty branch-relative `subpath` so branch-root reads are not implicit.
- `agor_kb_outline` and `agor_kb_get_range` provide bounded remote reads for large documents, returning line ranges, compact outline size hints, exact-read content hashes, and the current version token.
- `agor_kb_materialize` writes a KB markdown snapshot plus a `.agor-kb.json` sidecar into a branch worktree after branch `session` permission and containment checks. `agor_kb_publish_from_worktree` reads the branch-relative file back, uses the sidecar for document/version context when present, and updates existing documents through the targeted edit service so one publish creates one KB version.
- Automatic markdown link extraction is KB-document-link oriented. Links to sessions, boards, branches, external URLs, etc. should be represented with explicit `agor_kb_link` calls until/unless broader auto-link extraction is intentionally added.
- Review follow-up moved branch workspace path/RBAC/canonical containment into a shared daemon utility used by KB and artifacts, and moved markdown outline/range parsing into a shared daemon knowledge helper backed by the existing remark parser so fenced code blocks do not create false headings.
- Worktree materialize/publish validates the derived `.agor-kb.json` sidecar path through the same branch-workspace canonical containment helper as the markdown file before reading or writing it. Worktree publish updates the sidecar after successful non-dry publishes so subsequent publishes carry a fresh expected version.
