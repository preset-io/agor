# Knowledge namespace migration: assessment and proposed v1

**Historical assessment — 2026-09-22.**

Implementation was subsequently authorized in this session. The assessment below
records the pre-implementation evidence and proposals, not the current worktree
status. Current CLI behavior and limits are documented in
[the Knowledge guide](apps/agor-docs/content/guide/knowledge.mdx#move-a-namespace-with-the-cli).

**Original design-only inspection:** Branch: `investigate-kb-namespace-migration`.
Inspected `HEAD`, local `main`, and local `origin/main`, all exactly
`59b86fe17fe16a445b5e2f980b6718556eede619`; working tree was initially clean.
No remote refresh was performed, so this is the inspected main SHA, not a claim
about GitHub's latest tip. No feature implementation, live KB reads/writes,
deployment, environment startup, PR, or manual callback was performed.
This report is the only repository change. Source references below are relative
to this repository at that SHA. Repository dependencies were absent; a disposable
`simple-git` installation under `/tmp` was used for read-only Git inspection.

## Recommendation

Build **one versioned directory + manifest format**, initially exported/imported
by a deterministic CLI client against authenticated APIs. Make the first product
contract **“migrate all current markdown documents in a namespace”**, not “full
backup.” Include drafts explicitly. Default import creates a new, importer-owned,
restricted namespace; allow safe replay, but no general merge/overwrite/delete in
the first release. Add a small bounded inventory read surface and narrow
idempotent-create admission rather than a job framework. Reuse normal document
creation, authorization, indexing and attribution inside that admission boundary.

The same format can subsequently travel as a streamed `tar.gz`, browser download,
or executor materialization. **S3 is not a prerequisite for archives or HA.**
Choose browser-first streaming instead if a nontechnical download/upload UX is a
release requirement; that is a transport decision, not a reason to change format.

This v1 intentionally does **not** deliver historical restoration, ACL migration,
an offline asset-complete mirror, or bidirectional synchronization. If any of those
defines “full” for the intended migration, expand scope before implementation.

## CLI refinement: plan first, visible progress, incremental work

Follow-up product direction: CLI is the preferred transport; prioritize a simple
rsync-like **inventory → plan → apply** workflow with explicit `N / X` progress.
This means one-way selective copying, not rsync's block-delta protocol or automatic
bidirectional synchronization. The create/replay-only initial import policy below
still applies; arbitrary existing-document replacement is a separate opt-in scope.

**Hashes already exist.** `hashContent` in the Knowledge repository computes MD5,
SHA-256 and UTF-8 byte length, and normal document create/update stores them in
`kb_document_versions`. Use **SHA-256**, not a new hash column. The missing piece
is an efficient metadata-only inventory projection of current-version hash/size.
Select those columns explicitly: fetching full version rows and stripping bodies
afterward would save network bytes but still unnecessarily read bodies from DB.

Proposed inventory fields: document ID, path, title/kind/icon/status, permitted
descriptive metadata/frontmatter, current version ID, `content_sha256`,
`byte_length`, and a canonical fingerprint of the metadata this profile copies.
The metadata fingerprint can be calculated at read time; no extra stored hash is
necessary initially. Version IDs protect reads/rechecks, not cross-instance equality.
Legacy null hashes mean `unknown`, never `unchanged`: plan a bounded fetch/verify
fallback and expose its count. Avoid a compulsory historical backfill in v1.

Planning does not fetch remote bodies with known hashes. Export compares remote
hashes with calculated local file hashes; import hashes local input and compares
against authorized destination inventory. Local hashing still reads local bytes;
mtime alone is not integrity proof. When link rewriting changes destination bytes,
compare against the planned transformed hash or recorded source/destination hash
pair, not the untransformed source hash alone.

### Progress contract (illustrative export output)

```text
Planning: source inventory     200 / 1,240 documents
Planning: local checksums     1,240 / 1,240 files
Plan: 1,000 unchanged; 180 new; 40 content changes; 20 metadata-only changes
Transfer needed: 220 documents, 8.4 MiB; conflicts: 0; unknown hashes: 0
Applying: 73 / 240 actions | transferred 2.8 / 8.4 MiB | elapsed 00:12
Complete: 240 / 240 actions; 1,000 unchanged; 0 failed
```

Changed local managed files require safe replacement preconditions; unrelated or
independently edited files are conflicts. On create/replay-only import, changed
existing KB documents are also conflicts, not silently replaced. Display that
distinction in the plan. A document with both metadata and body changes counts
once; metadata-only actions need no remote body. Byte totals describe logical
content, not compressed HTTP wire bytes.

- Show discovery immediately, even before its denominator is known. A source count
  must use the same authorized filters; label it a count at scan start until
  enumeration completes. If counting is slow, show `N discovered` and elapsed
  time, not an invented percentage. Count drift triggers a visible replan.
- Once inventory/local enumeration finishes, freeze the plan and exact action
  totals. Show planning/hash progress as well as transfers. Unchanged documents
  appear in the summary, not silently absent from totals.
- Every apply starts with a plan; `--dry-run` stops after that same planner without
  writes. Apply rechecks preconditions, reports stale-plan conflicts and never
  overwrites edits made since planning. No separate dry-run implementation.
- Human progress goes to stderr; machine summary goes to stdout. Use a compact
  updating display on TTYs and throttled newline milestones otherwise. During a
  slow request show elapsed time/current phase/retry status. Never log bodies,
  credentials or full server errors. Structured progress events can be optional.
- On failure/cancel, print completed/total, unchanged, failed/pending counts and
  the resume command. Retries must not double-count; failed actions are not
  successful completions. Ctrl-C stops scheduling; in-flight writes may finish,
  so preserve the receipt for reconciliation.
- Completion includes writes and required reference reconciliation, not finishing
  asynchronous embeddings. Report indexing separately as queued under destination
  policy rather than keeping the CLI open indefinitely.

Add focused tests for unknown totals, inventory drift, no-op repeats, metadata-only
changes, missing hashes, rewritten-link hashes, non-TTY output, slow requests,
retries/cancel and final counts. Assert unchanged planning does not select/transfer
remote `content_text`/`content_blob`. This refinement remains design only.

## Verified implementation and concrete paths

| Area                   | Evidence and consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical guide        | [Knowledge guide](apps/agor-docs/content/guide/knowledge.mdx). Instructions name `pages/guide`, but this checkout uses `content/guide`. It describes DB-backed markdown, history, graph, MCP and worktree round trips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Storage                | [PostgreSQL schema](packages/core/src/db/schema.postgres.ts), `kbNamespaces`, `kbNamespaceAcl`, `kbDocuments`, `kbDocumentVersions`, `kbDocumentUnits`, `kbGraphNodes`, `kbGraphEdges`; equivalent [SQLite schema](packages/core/src/db/schema.sqlite.ts). Bodies are version rows, not namespace directories or S3 objects. PG rows carry `tenant_id`; active namespace slug and document namespace/path uniqueness are tenant-scoped partial indexes. Archived generations can reuse a path.                                                                                                                                                                                                                                                                             |
| Content types          | [Knowledge types](packages/core/src/types/knowledge.ts) and [repository](packages/core/src/db/repositories/knowledge.ts), `KnowledgeDocumentRepository.create/update`: reject MIME other than `text/markdown`, set `content_blob:null`, compute SHA-256, MD5 and lengths. Blob/MIME fields and `bundle`/`external` kinds do **not** establish a binary-attachment implementation. Legacy/unexpected non-markdown rows must cause an explicit unsupported-content outcome, not export as empty markdown.                                                                                                                                                                                                                                                                    |
| Paths                  | `normalizeKnowledgePath` rejects traversal segments, control/reserved filesystem characters and Windows device names, but normalizes leading/repeated slashes. No requirement for `.md`. Case/Unicode-equivalent paths and file/directory prefix collisions still need portable mapping. `uri` is slug/path-based; `agor://kb/document/<uuid>` is rename-proof only inside its source instance.                                                                                                                                                                                                                                                                                                                                                                            |
| Metadata/history       | Types/schema store title, icon, kind, visibility, status, edit policy, JSON document metadata, creator/updater/timestamps; versions carry body, separate JSON frontmatter, version metadata, summary and human/session/tool/teammate attribution. `KnowledgeDocumentVersionRepository.findAll` orders versions; `KnowledgeVersionsService.find` checks document/namespace activity and read access, then optionally strips content. Other version methods reject mutation. Replaying writes is not authentic historical restoration.                                                                                                                                                                                                                                       |
| Delete/archive         | `KnowledgeDocumentRepository.delete` sets `archived`, `archived_at`, `updated_at` and fences index work; it does not erase historical content. `KnowledgeDocumentsService.get/getDocument` rejects archived documents/namespaces. `find` permits an admin's archived filter and hydration; ordinary readers cannot export trash through the same path. `KnowledgeVersionsService.find` returns no history for archived docs. Namespace deletion archives the namespace and its documents and fences index work.                                                                                                                                                                                                                                                            |
| Listing                | [KnowledgeDocumentsService.find](apps/agor-daemon/src/services/knowledge-documents.ts) overrides pagination and calls unbounded `repo.findAll`; constructor pagination settings do not make this paged. [MCP knowledge tools](apps/agor-daemon/src/mcp/tools/knowledge.ts), `agor_kb_tree`, pages `kb/search` with offset and limit+1. `KnowledgeSearchRepository.search` fetches an increasing `offset+limit` prefix, joins current content and sorts by mutable `updated_at`, then slices. It is usable for modest browsing, not an efficient stable migration cursor. Namespace/history MCP paging also slices already-fetched authorized arrays.                                                                                                                       |
| Read/write APIs        | [Service registration](apps/agor-daemon/src/register-services.ts) exposes `kb/namespaces`, `kb/documents` (including `getDocument`, `putDocument`), `kb/versions`, `kb/document-edits`, `kb/search`, `kb/graph`. `KnowledgeDocumentsService.putDocument` resolves by ID or namespace/path, optionally creates namespace, then creates/updates, replaces search units, syncs references and emits events. Its convenience namespace creation uses defaults unsuitable for private migration unless explicitly overridden. No KB-specific CLI commands were found under `apps/agor-cli/src/commands`; tenant export/import commands are a different product.                                                                                                                 |
| Concurrency            | [KnowledgeDocumentEditsService.create](apps/agor-daemon/src/services/knowledge-document-edits.ts) checks expected version, supports dry-run and delegates to `putDocument`. Content writes use `runPolicyDependentWrite` and [runKnowledgePolicyTransaction](apps/agor-daemon/src/knowledge/policy-transaction.ts), with PG semantic-policy aggregate locking / SQLite IMMEDIATE; repository update also locks the document row. This is meaningful reuse, but not a general document+metadata compare-and-swap contract: `patch/update` do not enforce `expected_version`, and the repository strips/does not itself compare that token. Any future merge must validate all relevant fields under the write lock and test races with metadata/archive/governance changes. |
| Graph/tags/frontmatter | `extractKnowledgeLinks` recognizes KB ID/path URI and in-app route forms. `KnowledgeDocumentsService.syncGraphReferences` rebuilds outgoing `references` on content write; failures are logged and swallowed. [KnowledgeGraphService](apps/agor-daemon/src/services/knowledge-graph.ts) and graph repository also support explicit typed edges and nodes (including tags, external and non-KB entities). Those explicit relationships are not reconstructible from markdown. No first-class document tag column: retain metadata/frontmatter tags as data, distinguish graph `tagged_with` edges. Frontmatter JSON is separately stored, not automatically equivalent to YAML text inside the body.                                                                        |
| Authorization          | [knowledge-access.ts](apps/agor-daemon/src/services/knowledge-access.ts): namespace read permission **plus** document visibility overlay. Private docs are readable by author/admin, not automatically every namespace owner. Write permission has a separate edit-policy overlay. Drafts are not secret but other authors' drafts are hidden from browsing by default. [KnowledgeNamespacesService](apps/agor-daemon/src/services/knowledge-namespaces.ts) restricts governance/ACL management to effective `own`. Source `public` is not anonymous internet-public.                                                                                                                                                                                                      |
| Tenant boundary        | [register-hooks.ts](apps/agor-daemon/src/register-hooks.ts) classifies KB services as tenant-owned and installs auth/roles; [MCP tenant scope](apps/agor-daemon/src/mcp/tenant-scope.ts) supplies scoped units and write-gate enforcement for custom mutations. Files, manifests, checkpoints and future objects are tenant-owned/derived too: RLS alone does not protect them. Use trusted request tenant identity, never manifest tenant IDs.                                                                                                                                                                                                                                                                                                                            |
| Attribution            | [KnowledgeAttributionRepository](packages/core/src/db/repositories/knowledge-attribution.ts) projects safe display names, not email/profile data, after document authorization. `knowledgeWriteParams` supplies trusted session attribution. Document service can honor requested user attribution for admins: an importer must **not** forward arbitrary source `created_by`/`updated_by` even when its caller is admin.                                                                                                                                                                                                                                                                                                                                                  |

### Existing materialize is export; publish is the inverse

`agor_kb_materialize` → `fetchKnowledgeDocument` → `kb/documents.get/getDocument`
→ `runBranchKnowledgeCommand('branch.knowledge.write')` → branch lookup and
`ensureBranchWorkspaceAccess` (`session` capability + write filesystem access)
→ command-scoped executor token → `requestExecutor` →
[handleBranchKnowledgeWrite](packages/executor/src/commands/knowledge.ts).
It writes one UTF-8 file plus `<file>.agor-kb.json`, defaults below `.agor/kb`,
and refuses existing files unless `overwrite:true`. Sidecar records source ID,
URI, version, digest and materialization attribution; not all portable metadata.

`agor_kb_publish_from_worktree` uses the corresponding read command, reads that
sidecar, then edits an existing document with expected-version checks or creates
one through `putDocument`. After publication it rewrites the file/sidecar. This
is a same-instance editing workflow; copying its source UUIDs to another instance
does not make a migration. KB publication and sidecar update are separate effects.

[resolvePathInsideBranch](packages/executor/src/commands/branch-filesystem.ts)
checks branch-relative containment and existing symlink escape. File and sidecar
writes are not atomic as a pair; neither handler provides namespace checkpoints.
Reuse the executor boundary, but a namespace importer needs stronger no-follow,
exclusive/atomic file handling, including TOCTOU coverage.

[spawn-executor.ts](apps/agor-daemon/src/utils/spawn-executor.ts) supplies response
timeouts, local/delegated execution and a cancellable command facility; the KB
helper awaits a single `requestExecutor` result. There is no namespace migration
job/progress/resume contract here. The materialize/publish handlers require a
branch but do not themselves demand `ctx.sessionId`; calling the branch capability
`session` is not proof of session-only MCP access. A new Agor-session-only bulk
tool would need an explicit context check and bounded orchestration.

**Clarification of the repeated proposed signature:**
`knowledge_materialize(namespace, root_folder)` should mean **KB → directory**.
Use a separate `knowledge_import(root_folder, destination_namespace)` for the
inverse. Never infer direction from files existing or overload it into “sync.”
For MCP, root is branch-relative with an authorized `branchId`, not an arbitrary
daemon path. A local CLI may use a user-selected local root without an Agor session.

`only_markdown=true` needs a defined meaning: MIME filtering currently adds little
because normal KB writes are already markdown. If it means _omit manifest and
metadata_, name that a lossy `markdown-only` export mode, not migration. Filter by
MIME, not filename extension; reject unsupported data unless omissions are explicit.

`archive_deleted` is ambiguous and should not ship under that name:

- Exporting existing source trash: `include_archived`; copy bodies/tombstones,
  never alter source or destination. This is outside recommended v1.
- Pruning a materialized directory: a separate local option, only for previously
  managed files, never unrelated files; missing permissions are not deletions.
- Archiving destination KB entries absent from an imported tree: a separate,
  destructive `archive_missing` option, **off and unsupported in v1**. Later it
  requires explicit opt-in and an authoritative completed inventory of the same
  scope, not a partial scan, filtered view or interrupted export.

SHA comparison saves bytes/writes. Conflict-safe two-way sync additionally needs
common ancestry, stable identity across runs, local and remote revision checks,
rename/deletion semantics, and three-way conflict handling.

## What “full” can mean

| Resource                                      | Recommended current-document migration                                                                                                                    | Full-fidelity migration / backup difference                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active documents, published + drafts          | All supported current markdown bodies; title/icon/kind/status, selected descriptive metadata and separate frontmatter                                     | Require explicit inclusion of others' drafts; never silently call a visibility-filtered subset full                                                                                                      |
| Namespace                                     | Display name/description and source kind/settings as provenance; new restricted generic namespace                                                         | Binding a repo/branch/user/team namespace needs explicit destination entities; teammate home links and grants are not portable automatically                                                             |
| Ownership, timestamps, author/tool provenance | Source facts in manifest; importer owns new namespace/docs; destination timestamps and attribution describe actual import                                 | Original authoritative history/attribution is not restored; email matching is optional future mapping, never authorization                                                                               |
| History and archived generations              | Excluded with manifest declaration                                                                                                                        | All versions, summaries, archived bodies/timestamps and reused-path identities require a dedicated authenticated restoration contract, not fake sequential user edits                                    |
| Governance                                    | Record source document policy as provenance; no ACL or role application                                                                                   | User/group grants, `others_can`, edit policy and visibility migration require explicit reviewed destination mapping                                                                                      |
| Links/backlinks                               | Preserve body bytes in bundle; rewrite supported in-scope KB links on import, with a report; rebuild references after all targets exist                   | Explicit edges, graph properties/tags/confidence and cross-resource relationships need an optional graph section and two-pass identity mapping                                                           |
| Attachments/assets                            | No KB-owned attachment table/relation found. External URLs and upload/branch-file references remain references; report recognized unresolved dependencies | Offline completeness requires discovering and independently authorizing each referenced asset, copying bytes and rewriting references. Do not assume the session upload store belongs to the KB document |
| Derived/system state                          | Exclude search units/vectors/claims/caches, tenant semantic settings and provider secrets                                                                 | Rebuild search from destination policy; an application backup/operator tenant archive is a different recovery tool                                                                                       |

**Irreversible at the destination if source/bundle evidence is discarded:** old
revision bodies, original authoritative author/version/timestamp history,
archived documents, manual graph edges and inaccessible/expired external assets.
Retaining current source provenance does not recover excluded history. A migration
copies useful semantic content into a new authority domain; backup restores state;
synchronization continually reconciles divergent states. Do not sell one as another.

## Transport alternatives and HA assumptions

Format and transport are independent: all options below can use the same manifest
and byte layout. Effort is relative to the recommended CLI baseline (1×), includes
safety/tests, and is an uncertain planning estimate, not a delivery commitment.

| Option / UX                                | Implementation/reuse                                                                                                        | HA and performance/limits                                                                                                                                                | Security, operations, test burden                                                                                                                         | Relative effort                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Directory + manifest via CLI               | Deterministic export/import commands, auth client, existing services, bounded inventory and idempotent-create API gaps      | No daemon-local files; any replica handles requests against shared DB. Page/checkpoint locally; request count and per-document JSON limits matter                        | Client owns sensitive files. No object retention/job ops; test format, auth, replay, partial failure                                                      | **1×**, medium; roughly 1–3 engineer-weeks, wide uncertainty           |
| Existing paged APIs only                   | `kb/search`/tree + get + create; useful prototype/small corpus                                                              | Offset paging is mutable and increasingly expensive; document/history list is not truly paged. No snapshot guarantee                                                     | Lowest endpoint surface, but incomplete/draft/filter traps; cannot promise full history restoration                                                       | 0.6–1× for constrained export; safety gaps prevent calling it complete |
| Bulk MCP directory materialization         | Reuse executor tokens, branch authorization/path helpers; add namespace orchestration                                       | Files live with branch/executor substrate, not arbitrary HA daemon. Avoid one executor spawn per doc / huge command JSON                                                 | Branch collaborators may gain access to exported private data; explicit destination warning, checkpoints and cancellation tests                           | 1.3–2×                                                                 |
| Client `tar.gz` / ZIP packaging            | Wrap same directory layout; gzip/tar is sequential; ZIP can also stream with a suitable library                             | Compression/storage on client, no S3. ZIP suits desktop users; tar suits CLI. Do not require both first                                                                  | Archive parser greatly increases hostile-input tests; expanded-byte limits, not compressed size alone                                                     | +0.2–0.5× packaging; safe archive import adds more                     |
| Streamed server archive / browser download | Authorized inventory + bounded body reads → archive encoder → HTTP with backpressure                                        | Replica streams DB data; no shared archive disk or S3. A failed connection restarts, not transparent failover. Proxy buffering/timeouts still need deployment validation | Rate/concurrency/byte caps, disconnect cancellation, safe attachment disposition, final completion marker. Low retention cost; streaming/revocation tests | 1.3–2×; upload/import UI extra                                         |
| Staged object-store job                    | Reuse storage adapters conceptually; needs durable operation ownership, claims, status, cancel/retry/TTL/download authority | Useful for very large/history/assets bundles, expiring downloadable artifacts or work surviving request/worker loss                                                      | More quota, cleanup, lease/replay and signed URL/proxy choices. Existing upload ownership is not namespace ownership                                      | 2.5–4×, high uncertainty                                               |
| Git/file integration                       | Portable directory commits; existing one-doc round trip is a starting point                                                 | Git history is export history, not original KB history; conflict resolution and branches add ongoing state                                                               | Private data leakage into repo/history, source-of-truth choice, rename/deletion/conflict and credential tests                                             | 3–5× for genuine ongoing integration                                   |

### What storage already exists

[UploadStagingStore](packages/core/src/types/upload.ts) is a streaming temporary
ingress port with stage/inspect/read/consume/delete/cleanup, owned by tenant,
session, branch and creator. [configureUploadStagingStoreFromConfig](apps/agor-daemon/src/utils/upload-staging.ts)
selects a local adapter or `s3://bucket/prefix`; local paths use
`getManagedStorageSegments('uploads', ...)`. Defaults from config are 50 MiB per
file and 30-day retention; multipart handling additionally bounds file count and
aggregate bytes ([upload.ts](apps/agor-daemon/src/utils/upload.ts)).

[S3UploadStagingStore](apps/agor-daemon/src/utils/s3-upload-staging-store.ts)
already exists in this repo with AWS SDK multipart upload, tenant-prefixed keys,
owner metadata verification and ranged `GetObject`. The factory permits a Cloud
override but has a built-in adapter; its comment suggesting exclusive Cloud SDK
ownership is not the whole implementation. S3 expiration/abandoned multipart
cleanup relies on bucket lifecycle. [MetadataUploadStagingStore](apps/agor-daemon/src/utils/metadata-upload-staging-store.ts)
adds durable metadata/admission around the adapter.

[register-routes.ts](apps/agor-daemon/src/register-routes.ts),
`GET /executor/uploads/:uploadRef/content`, demonstrates an authorized stream
piped to a response and destroyed on disconnect. It is an **executor-only**
data plane, not a general KB download endpoint. Browser upload routes authorize
session/prompt access. Reuse stream limits/adapters where appropriate, not these
session handles as invented permanent KB attachment ownership. A new namespace
archive owner/purpose is required if staging is added.

HA with local staged files requires shared storage or correct owner routing;
metadata in shared DB does not make node-local bytes shared. Conversely, a
stateless DB-to-response archive needs neither. If staging later uses S3, a
short-lived authorized object URL could avoid a proxy, subject to revocation and
deployment policy; the current executor route proxies and no presigned KB route
was found. Actual Cloud proxy settings/storage topology were not inspected and
are not inferred. Cloud code is not necessary to establish format feasibility.

There is already an operator-level [tenant archive format](packages/core/src/db/tenant-archive.ts)
and [exportTenant](packages/core/src/db/tenant-export.ts): directory manifest,
table JSONL, hashes and optional filesystem tree, with operator quiescence
preconditions. Reuse ideas/appropriate pure validation helpers, not raw
tenant rows/credentials or its identity-preserving import as namespace migration.

**Disposable synthetic feasibility probe:** Python `tarfile` in `w|gz` mode
streamed 10,000 generated UTF-8 markdown entries (52,280,000 content bytes) into
a counting/discard sink: 248,675 compressed bytes, process peak RSS 19,348 KiB,
no disk archive and no real content. This tests the narrow assertion that tar.gz
requires neither seekable output nor stored archive bytes. It does not benchmark
Agor/Node/DB/HTTP, realistic compression, HA failover or deployed proxy behavior.

## Proposed portable format (illustrative, not implemented)

```text
namespace-export/
  manifest.json                   # written last, only after completed export
  documents/runbooks/start.md      # exact source UTF-8 bytes
  objects/d2.md                    # fallback when logical paths cannot map safely
  # optional future history/, assets/, graph.json; never implied when absent
```

```json
{
  "format": "agor-knowledge-namespace",
  "version": 1,
  "bundle_id": "example-bundle-1",
  "namespace_key": "n1",
  "profile": "current-markdown",
  "completed": true,
  "consistency": "per-document-version; non-atomic-inventory",
  "exported_at": "2026-09-22T12:00:00Z",
  "namespace": {
    "slug": "example",
    "display_name": "Example",
    "description": "Synthetic example only",
    "source_kind": "team",
    "source_uuid": "informational-only",
    "source_settings": { "visibility_default": "private", "others_can": "none" }
  },
  "scope": {
    "drafts": "all",
    "archived": false,
    "history": false,
    "assets": false,
    "explicit_graph": false
  },
  "documents": [
    {
      "key": "d1",
      "path": "runbooks/start.md",
      "file": "documents/runbooks/start.md",
      "mime_type": "text/markdown",
      "sha256": "<64 lowercase hex digits of exact stored bytes>",
      "bytes": 123,
      "title": "Start",
      "kind": "guide",
      "status": "published",
      "frontmatter": {},
      "metadata": {},
      "source_policy": { "visibility": "private", "edit_policy": "owner" },
      "provenance": {
        "source_uuid": "informational-only",
        "source_version_uuid": "informational-only",
        "source_version_number": 7,
        "created_at": "2026-08-01T12:00:00Z",
        "updated_at": "2026-09-01T12:00:00Z",
        "creator_display_name": "Example author",
        "updater_display_name": "Example editor"
      }
    }
  ],
  "links": [],
  "omissions": ["history", "archived documents", "explicit graph", "asset bytes", "ACLs"]
}
```

Use bundle-local opaque keys for identity, distinct from mutable logical paths.
They stay stable across resume/replay of this bundle; they do not magically track
renames across independent exports. Later repeated exports can carry an explicitly
maintained lineage map. Destination map is `(bundle_id, namespace_key, document_key)`
→ new destination ID, scoped to authenticated destination tenant and namespace.
Source UUIDs/tenant IDs/session IDs are provenance and link-resolution inputs,
never destination lookup authority. Neither guessed matching UUID nor email grants
access. Optional explicit user mapping belongs to a later audited admin workflow.

Store exact UTF-8 bytes (including original newlines/BOM if present); no silent
normalization. Validate UTF-8 strictly on import. Hash **exported bytes**, compare
against stored source digest where available, and record a separate destination
digest after link rewriting. Canonical metadata digest must participate in replay:
equal body hashes do not imply equal metadata or policy. A manifest fingerprint
binds entries/options, excluding itself; hashes detect corruption, not authenticity.

Keep logical path in the manifest regardless of physical mapping. Preflight
case-folding, Unicode normalization, path lengths, duplicate entries and `a` versus
`a/b` conflicts; use deterministic `objects/<key>.md` fallback, never silently
rename destination KB paths. The importer follows manifest entries only, not every
file discovered recursively. Validate keys too before using them in paths.

Preserve arbitrary source metadata/frontmatter as **untrusted inert provenance**;
apply only an allowlist of descriptive fields to live destination metadata.
Fields carrying source entity IDs, executable integration settings or permissions
must not silently activate. Preserve separately stored frontmatter and body YAML
without merging contradictory values. Include current version metadata/summary
and assistant attribution in the provenance extension when available.

For links, inventory source ID and source slug/path aliases to portable keys.
Use markdown-aware parsing to rewrite supported in-scope links to destination
slug/path URIs (possible before IDs exist), preserving fragments/query components;
do not replace inside code fences or perform global UUID string substitution.
Treat absolute source-origin KB links only against an explicit origin allowlist.
After all docs exist, perform a bounded authorized reference reconciliation without
creating fake content revisions; graph-save best effort alone is insufficient.
Unmapped cross-namespace/resource links remain unchanged and are reported, never
automatically fetched. Future assets require an authorized asset manifest with
MIME/size/digest, deduplication by bytes, verified completeness and URL rewrite map.
External URL crawling is not an import feature (SSRF, credentials and privacy).

## Concrete v1 contract and safety

Proposed names (not existing commands):

```text
agor kb export --namespace SOURCE --output DIRECTORY
agor kb import DIRECTORY --namespace NEW_SLUG --dry-run
agor kb import DIRECTORY --namespace NEW_SLUG --apply
agor kb import DIRECTORY --namespace NEW_SLUG --resume --apply
```

1. **Authority:** For v1's namespace-complete current-doc profile, require a
   source tenant admin, still inside trusted tenant scope; this avoids claiming
   namespace ownership permits export of another author's private documents.
   A later `readable-subset` profile may support ordinary readers, marked partial
   without disclosing hidden counts/paths. Recheck authorization at page/body
   boundaries and before final completion; revocation stops further output.
   Already exported bytes cannot be recalled. Destination requires member/create
   authority and normal write checks; never bypass service authorization.
2. **Bounded export:** Add keyset inventory pages ordered by immutable ID, with
   current version ID, document metadata and a metadata fingerprint; include all
   drafts explicitly. Fetch selected immutable versions through authorized reads.
   Require an active namespace; archived namespaces/docs and unexpected binary
   rows are unsupported, explicitly reported. Use client byte/count limits and
   small concurrency rather than bulk content in LLM context.
3. **Consistency:** Guarantee each exported body matches its recorded version and
   digest, **not** a namespace point-in-time snapshot. A second inventory comparison
   can detect many changes and fail/retry; it cannot prove there were no transient
   insert/delete/metadata changes between scans. Record start/end time and exact
   semantics. Recommend user-coordinated source quiescence for cutover, with a
   final verification; this is a precondition, not an enforced freeze. No HTTP-long
   transaction or snapshot/job infrastructure in v1.
4. **Completion/resume:** Write to a private temporary directory with checkpoint
   state; publish final manifest atomically only after bodies, hashes and scope
   checks succeed. Reject missing/incomplete manifests. Resume verifies existing
   bytes and rechecks source inventory/authority; never finalizes a mixture
   silently after detected changes. Exported content is sensitive even on disk:
   private modes, no content in logs, no automatic Git commit, warn before shared
   branch destinations. Local caller is responsible for bundle retention/deletion.
5. **Dry-run:** Offline schema/path/byte/digest validation plus authenticated
   destination authority, slug availability, limits, mapping and unresolved-link
   plan; return creates/skips/conflicts/losses, no namespace or document writes.
   Apply revalidates because dry-run is not a reservation. No background jobs,
   indexing calls or live-file mutation during dry-run.
6. **Create/resume only:** Default fail if destination active namespace exists.
   Create a generic importer-owned namespace with `others_can:none`, private
   default visibility and importer owner grant, regardless of source defaults.
   New docs are importer-owned, private, edit-policy owner; retain draft/published
   status. Display name/description/title/icon/kind are preserved. Review and
   explicitly share afterward. No source ACL/admin-role import or email lookup.
7. **Replay:** Bind namespace/document creates to bundle fingerprint, options and
   portable key atomically with the write. A narrow tenant/user-bound create
   admission must serialize duplicate requests and retain their destination IDs
   (small durable receipts, not jobs). Local receipts contain target IDs/versions,
   not credentials. After a lost response, resolve the receipt and reauthorize:
   skip only matching complete imported state; mismatch is a conflict. **Existing
   active-path lookup plus sidecar/JSON metadata alone is insufficient:** a document
   could have committed and then been renamed/archived before the acknowledgement.
   Its durable receipt must still resolve to that original identity and report
   conflict, never recreate it. Receipt and content commit together; retain receipts
   through archive for the supported replay lifetime, and reject expired/unknown
   resume operations rather than guessing. Unique active path constraints also
   reject unrelated collisions; never upsert over them. Markers/receipts identify,
   not authorize. Resume requires the same authorized destination and plan; an
   unchanged bundle replay creates no extra versions. This small API/schema gap
   is included in the estimate, unlike a generic job framework.
8. **No merge/delete:** An explicit existing-namespace merge can be a later mode:
   default collision error; explicit skip or version-checked replace. Compare
   both base content and metadata/governance under lock; no last-writer-wins SHA
   shortcut. V1 neither archives missing destination docs nor restores source
   trash. Cancellation leaves a clearly partial, restricted namespace and resumable
   receipt; it does not secretly roll back/delete already committed documents.
9. **Input bounds:** Provisional defaults: 10,000 docs, 10 MiB per document, 100 MiB
   total uncompressed content, 10 MiB manifest, bounded metadata nesting/path
   depth/length, concurrency 2–4; tune with synthetic profiling and existing API
   body limits before release. Fail before mutations wherever possible. Directory
   reads reject symlinks, devices, absolute/traversal paths, NULs, duplicate keys,
   normalized aliases and unsafe ancestor paths; use safe opened handles, not
   validation followed by unrestricted reads. Extraction later additionally
   rejects hardlinks, encrypted/unsupported entries, zip-slip, duplicate archive
   paths and bombs, enforces actual expanded bytes/count/time and cancellation,
   and stages privately before any KB writes. Never run extracted content.
10. **Lifecycle/HA:** Client abort stops scheduling requests; in-flight single-doc
    atomic writes may finish, so resume must handle uncertain acknowledgements.
    Checkpoint progress is documents/bytes/conflicts, not an Agor Task's LLM state.
    Each API request carries current authenticated tenant/user identity. Future
    streams abort DB work on disconnect; future jobs bind tenant/user/purpose in
    durable state, reauthorize downloads and scope quotas/cleanup to that owner.
    No token, checkpoint or object key from tenant A may act in tenant B.

Jobs/object storage become warranted when measured work regularly exceeds request
budgets, the user must disconnect while export continues, durable downloadable
artifacts/range resume are required, or history/assets exceed bounded client
handling. Those are specific requirements, not automatic consequences of tar or
HA. Begin with bounded request/client orchestration; do not generalize embedding
claims or session tasks into a migration scheduler prematurely.

## Decisions and staged plan

No question blocks this assessment. Before implementation, confirm:

- Is current-document migration sufficient, or must archived docs/history/manual
  graph/asset bytes survive? Default above is deliberately not called full backup.
- Is CLI acceptable for v1, or must an admin use browser download/upload? Same
  format, different first transport. MCP bulk wrapper is optional, not foundational.
- Is source-admin-only acceptable for a guaranteed visibility-complete scope?
  Default is yes; otherwise name the result a readable subset.
- Are new restricted namespace and importer ownership acceptable? Default yes;
  no merge, automatic sharing or source identity restoration.
- What corpus/latency limits and source quiescence window are realistic? Defaults
  are provisional; exact proxy/HA topology remains an operational validation item.

Implementation stages, **only after authorization**:

1. Freeze scope, manifest schema, limits and error contracts; synthetic fixtures
   only. Add pure format/path/digest/mapping validation using canonical core types.
2. Add bounded authenticated inventory/read support; test drafts/private visibility,
   tenant isolation and mutation detection. Avoid changing browse semantics merely
   to accommodate export. Profile cursor/body reads on SQLite and PostgreSQL.
3. Build CLI export + dry-run/import/create/resume using existing auth/service
   boundaries, narrow atomic create receipts/provenance and two-pass link reconciliation.
   Any receipt schema change needs SQLite and PostgreSQL migrations. Add no generic
   job table. Validate policy/metadata races before enabling any
   replace mode. Document explicit losses and restricted ownership defaults.
4. Measure synthetic small/large corpora, faults and cancellation. Add one archive
   transport or MCP wrapper if UX calls for it. Browser streaming can precede CLI
   if product chooses, without introducing S3 staging.
5. Separately scope history/trash/assets/explicit graph, merge/mappings or Git sync;
   each changes fidelity/security expectations and needs its own acceptance tests.

### Test matrix for the eventual implementation

| Boundary              | Required positive and negative coverage                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                | Empty namespace/body; Unicode/BOM/CRLF; no `.md` extension; deep paths; title/icon/kind/status/frontmatter/provenance; deterministic digests; unknown version/required capability; corrupt/truncated/missing body/manifest             |
| Files/archives        | Case/Unicode aliases, `a` vs `a/b`, reserved names, long names; traversal and encoded separators; symlink/hardlink/ancestor swaps; duplicate entries, devices; expanded size/count/depth/time limits and bombs                         |
| Source auth           | Admin complete export includes others' drafts/private docs; ordinary namespace owner cannot claim full access to another author's private docs; revoked permission mid-run stops; hidden paths/counts never leak to subset users       |
| Tenant                | A can export/import; B cannot reuse A namespace/document/version ID, cursor, marker, checkpoint, token, upload ref or future download URL; missing/conflicting trusted tenant fails closed; static and required-from-auth modes        |
| Destination authority | Importer-owned private namespace/docs, no source ACLs/roles/user/session spoofing even as admin; arbitrary metadata cannot activate source bindings; dry-run and collision failures create nothing                                     |
| Consistency           | Concurrent body edit, metadata-only change, rename, draft/public/archive change, insert/delete during pages; selected-version integrity; change detection versus documented non-snapshot limitations                                   |
| Replay/faults         | Lost response after commit, restart after N docs, same bundle twice with no extra versions, changed options/fingerprint, local receipt corruption, externally edited/archived destination; partial namespace visibly partial           |
| Links/assets          | ID/path/relative/absolute KB references, escaping, fragments, code fences, forward/cyclic links; reconcile after all targets exist; unresolved cross-scope URLs reported, no external fetch; future asset digest/access mismatch fails |
| Scale/HA              | Bounded memory/concurrency and DB reads; byte caps; timeout/disconnect/cancel; requests served by different replicas; failed stream leaves no complete bundle; future local-store routing and object expiry tested separately          |
| Derived state         | New revisions/indexing/event attribution follows existing services; no false historical authors; graph reconciliation handles errors explicitly; embedding cost governed by destination policy                                         |

Existing evidence suites to extend include `services/knowledge.test.ts`,
`services/knowledge-document-edits.test.ts`, `mcp/tools/knowledge.test.ts`,
`services/knowledge-attribution.postgres.test.ts`, core repository Knowledge tests,
upload boundary/staging tests and tenant isolation tests. No application tests,
builds or compilation were run for this design-only task; the synthetic streaming
probe is feasibility evidence only, not implementation validation.
