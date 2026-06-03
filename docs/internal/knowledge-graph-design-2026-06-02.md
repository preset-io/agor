# Knowledge graph design — 2026-06-02

## Status

Draft design + schema skeleton. This document records the first implementation
shape for Agor's built-in knowledge base / graph. The first code pass should
keep the feature inert until services, MCP tools, and UI are added.

## Goals

- Store Agor knowledge in the database, not the filesystem.
- Address documents by stable namespace/path keys that can be materialized or
  exported later.
- Keep documents versioned and auditable.
- Support both SQLite and Postgres for baseline CRUD/history.
- Make advanced search features Postgres-only where appropriate.
- Support full-text search first; leave placeholders for semantic search and
  embeddings without building the embedding worker yet.
- Represent links between documents and core Agor objects without copying core
  objects into the document table.
- Support markdown-only knowledge documents in V1 and leave a clean path for
  skill bundles later.

## Naming and information architecture

### Top-level feature name

Use **Knowledge** as the user-facing product name.

- Navbar label: `Knowledge`
- Primary route: `/knowledge`
- Optional compatibility/shortcut route: `/kb`
- Modal/page title: `Knowledge`

Avoid using **Knowledge Graph** as the primary UI label. It is accurate for the
underlying architecture, but it reads as technical infrastructure. In user
interfaces, prefer simple concepts: browse, search, edit, link, and reuse
knowledge.

Use **Knowledge Graph** in technical docs, admin/debug surfaces, and possibly
marketing copy such as "connected knowledge graph." The schema can keep the
`kb_graph_*` names because graph nodes/edges are the internal model.

### Product vocabulary

| Concept              | User-facing name               | Internal/API/schema name   |
| -------------------- | ------------------------------ | -------------------------- |
| Whole feature        | Knowledge                      | `knowledge`, `kb_*`        |
| Namespace            | Space                          | `namespace`                |
| Markdown object      | Page or Doc                    | `document`                 |
| Page version         | Version                        | `document_version`         |
| Search/indexing unit | Hidden                         | `document_unit`            |
| Graph node/edge      | Mostly hidden                  | `graph_node`, `graph_edge` |
| Skill document       | Skill                          | `document.kind = skill`    |
| Memory document      | Memory                         | `document.kind = memory`   |
| Link graph UI        | Related, Backlinks, References | graph edges                |

### UI information architecture

Recommended top-level IA:

```text
Knowledge
  Browse
  Search
  Recent
  My Knowledge
  Public
  Skills
  Memories
  Backlinks / Related
  History
```

Creation affordances:

```text
New Page
New Skill
New Memory
```

Metadata labels:

```text
Space: Global / My Knowledge / This Repo / This Branch / Skills
Visibility: Public / Private
Editing: Owner only / Anyone / Admins
Type: Page / Skill / Memory / Reference
```

Avoid exposing implementation terms in primary UI:

```text
Namespace
Graph edge
Node
Embedding
Chunk
Document unit
```

### Documents vs pages

Use **Document** internally and in API/schema because it maps well to versioned
content, hashes, MIME types, immutable versions, and search indexes.

Use **Page** or **Doc** in the UI. `Page` is friendlier for a wiki/editor
experience; `Doc` is acceptable in compact controls. All page-like objects are
still `kb_documents` with a `kind`.

### Namespaces vs spaces

Use **Namespace** internally. Use **Space** in the UI.

Examples:

- `Global`
- `My Knowledge`
- `Agor Repo`
- `knowledge-base Branch`
- `Skills`

The URI remains namespace-slug based:

```text
agor://kb/global/getting-started.md
agor://kb/max/memories/postgres.md
agor://kb/agor/architecture/daemon.md
```

UI copy should say:

```text
Choose a space for this page.
```

not:

```text
Choose a namespace for this document.
```

## Non-goals for V1

- No filesystem materialization as part of normal operation.
- No RBAC or per-user grants beyond `visibility` and `edit_policy` fields.
- No embedding service, chunking worker, or provider integration.
- No graph visualizer.
- No external marketplace sync.
- No full skill-bundle upload yet; markdown-only skills can be represented as
  documents with `kind = skill`.

## Namespaces

Namespaces are first-class, user-manageable objects. They provide the URI segment
that scopes document paths:

```text
agor://kb/<namespace_slug>/<path>
```

Seed candidates:

- `global` — public shared instance knowledge.
- User namespaces — personal/private knowledge; slugs can be user handles.
- Repo namespaces — repository-level knowledge.
- Branch namespaces — branch-local knowledge if useful.
- `skills` — optional shared namespace for public skills; skills can also just
  be `kind = skill` inside any namespace.

The URI stays flat and friendly. Typed ownership lives on the namespace row via
nullable `owner_user_id`, `repo_id`, and `branch_id` fields.

## Visibility and editing

Defaults should be public because Agor is collaborative:

- `visibility = public` by default.
- `edit_policy = owner` by default, so public means public-readable, not
  automatically public-writable.
- A future `edit_policy = public` can enable wiki-like docs.

This is especially important for skills. Versioning makes edits reversible, but
public-write skills are still a supply-chain and prompt-injection surface.

## Documents and versions

`kb_documents` holds stable identity and current state:

- namespace/path unique key
- title/kind/visibility/edit policy
- current version pointer
- audit fields
- soft delete
- metadata

`kb_document_versions` holds immutable content snapshots:

- content text/blob reference
- MD5 for quick change detection
- SHA-256 for stronger integrity/provenance
- byte/char lengths
- frontmatter and metadata
- audit fields

The DB is canonical. Exporting a namespace/document/skill to a folder or zip can
be an explicit future feature.

## Search units, not chunks

Avoid making RAG chunking a product concept. Use `kb_document_units` as the
internal search/indexing unit:

1. Default to one unit per document version.
2. If markdown headings are parsed later, one unit per section is allowed.
3. Only split artificially when content exceeds configured/provider limits.

V1 can populate a single document-level unit. This gives us a future home for
full-text indexing, snippets, and embeddings without requiring a chunking
strategy now.

## Search

Baseline search should work on both SQLite and Postgres through service-layer
queries. Advanced search is Postgres-only:

- Full-text search: Postgres `tsvector`/GIN later.
- Fuzzy/autocomplete: Postgres `pg_trgm` later.
- Semantic search: optional `pgvector` later.
- Hybrid search: combine full-text, semantic, graph proximity, and recency later.

Schema placeholders should include embedding metadata/status fields but not a
worker.

## Graph model

Use a uniform node/edge model:

- documents and document units are graph nodes
- core Agor objects can be graph nodes by nullable FKs
- external URLs can be graph nodes by URI
- edges represent `references`, `contains`, `tagged_with`, `about`,
  `supersedes`, `derived_from`, etc.
- edge confidence is exposed by APIs as a `0..1` number but stored as integer
  basis points (`0..10000`) to keep the SQLite/Postgres skeleton simple and
  avoid a fourth dialect-specific scalar type.

Do not copy branches/sessions/tasks/artifacts into document tables. Existing
Agor objects remain authoritative in their existing tables.

V1 traversal can use adjacency queries / recursive CTEs. Apache AGE or another
Postgres graph extension can be optional later, not a schema dependency.

## Markdown and skills

V1 supports markdown-only documents, rendered in the UI with Streamdown.

Skills are modeled initially as `kind = skill` markdown documents. Future skill
bundle support should add bundle/file-map tables rather than storing only a zip:

- per-file relative path
- text/blob content
- content hash
- MIME type
- executable flag

Zip/folder import and zip export can be layered on top of that canonical DB file
map.

## External references

Markdown links are enough for authoring. The graph can still store external
references as `kb_graph_nodes.node_type = external` with `uri = https://...` and edges
from the source document/unit. Marketplace-specific IDs can live in metadata if
we later add importers.

## Proposed service/API surface

Initial Feathers services:

- `/kb/namespaces`
- `/kb/documents`
- `/kb/versions`
- `/kb/search`
- `/kb/graph`

Service-tier grouping: expose these under `services.knowledge` so lean/headless
daemons can set Knowledge to `off`, `internal`, or `readonly`, and so MCP
domain filtering can hide mutating Knowledge tools in readonly mode.

Initial MCP surface:

- `agor_kb_search`
- `agor_kb_get`
- `agor_kb_put`
- `agor_kb_history`
- `agor_kb_link`
- `agor_kb_graph_neighbors`

Initial UI:

- `/kb` route
- navbar knowledge icon/modal entry
- search/browse
- markdown view/edit
- history/revert
- backlinks/related objects list

### MCP tool input contract (scaffolded 2026-06-02)

The first MCP pass registers tools under the `knowledge` discovery domain and
keeps implementations thin: each tool delegates to `/kb/*` Feathers services
when present, and returns a structured `not_implemented` MCP error while the
backend services are still unregistered.

Naming stays with the shorter `kb` prefix because MCP tool names are agent-facing
and compact, while descriptions use the user-facing **Knowledge** name.

#### `agor_kb_search` → `/kb/search.find`

Read-only text search/browse surface. V1 services should support `mode: "text"`;
`semantic` and `hybrid` are reserved inputs that may return a clear unsupported
error until embedding/search workers exist.

```ts
{
  query: string;
  namespace?: string;      // namespace/space slug
  pathPrefix?: string;
  kind?: KnowledgeDocumentKind;
  visibility?: "public" | "private";
  includeArchived?: boolean;
  limit?: number;
  mode?: "text" | "semantic" | "hybrid";
}
```

#### `agor_kb_get` → `/kb/documents.get` or `/kb/documents.find`

Fetch by `documentId`, `uri`, or `namespace + path`. Defaults to
`includeContent: true` so agents can actually reuse markdown in context.

```ts
{
  documentId?: string;
  uri?: string;            // agor://kb/<namespace>/<path>
  namespace?: string;
  path?: string;
  version?: number | string;
  includeContent?: boolean; // default true
  includeLinks?: boolean;
}
```

#### `agor_kb_put` → `/kb/documents.putDocument` (preferred) or `.create`

Idempotent upsert keyed by `documentId`, `uri`, or `namespace + path`. The
preferred backend shape is a custom service method named `putDocument(data,
params)` so REST/UI/MCP can share version creation and optimistic concurrency
logic. The MCP fallback calls `.create(data, params)` if that is all the initial
service exposes.

```ts
{
  documentId?: string;
  uri?: string;
  namespace?: string;
  path?: string;
  title?: string;
  content: string;          // markdown; preserve whitespace exactly
  kind?: KnowledgeDocumentKind; // default doc
  visibility?: "public" | "private";
  editPolicy?: "owner" | "public" | "admins";
  frontmatter?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  changeSummary?: string;
  expectedVersion?: number | string;
}
```

#### `agor_kb_history` → `/kb/versions.find`

Read-only version listing. Same document addressing rules as `get`.

```ts
{
  documentId?: string;
  uri?: string;
  namespace?: string;
  path?: string;
  includeContent?: boolean; // default false
  limit?: number;
}
```

#### `agor_kb_link` → `/kb/graph.link` (preferred) or `.create`

Idempotent directed edge upsert. Node references intentionally accept Knowledge
URIs and core Agor object IDs so the graph can link to existing authoritative
objects without copying them into document tables.

```ts
{
  source: KnowledgeNodeRef;
  target: KnowledgeNodeRef;
  edgeType: KnowledgeGraphEdgeType;
  confidence?: number;
  properties?: Record<string, unknown>;
}
```

#### `agor_kb_graph_neighbors` → `/kb/graph.neighbors` (preferred) or `.find`

Read-only adjacency/traversal query. V1 can cap depth even if callers ask for
more.

```ts
{
  node: KnowledgeNodeRef;
  direction?: "out" | "in" | "both"; // default both
  edgeTypes?: KnowledgeGraphEdgeType[];
  nodeTypes?: KnowledgeGraphNodeType[];
  depth?: number;
  limit?: number;
}
```

Shared node reference shape:

```ts
type KnowledgeNodeRef = {
  nodeId?: string;
  uri?: string;
  nodeType?: KnowledgeGraphNodeType;
  documentId?: string;
  namespace?: string;
  path?: string;
  externalUri?: string;
  branchId?: string;
  sessionId?: string;
  taskId?: string;
  messageId?: string;
  artifactId?: string;
  repoId?: string;
  boardId?: string;
  userId?: string;
  label?: string;
};
```

## Implementation phases

### Phase 0 — skeleton

- Add core types.
- Add schema definitions in both dialects.
- Do not register services or run feature code yet.

### Phase 1 — CRUD/history thin slice

- Namespaces service.
- Documents service.
- Version creation on edit.
- Markdown-only editor/viewer.
- Basic search over current documents.

### Phase 2 — MCP and links

- MCP get/search/put/history/link tools.
- Graph nodes/edges service.
- Backlinks and linked Agor object panels.

### Phase 3 — advanced Postgres features

- Postgres FTS indexes/query path.
- Optional `pg_trgm` autocomplete.
- Embedding placeholders become active if configured.
- Optional `pgvector` and lazy embedding worker.

### Phase 4 — skills and export

- Skill markdown authoring polish.
- Bundle/file-map storage.
- Zip/folder upload.
- Zip export/materialization.
