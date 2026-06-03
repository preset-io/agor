# Knowledge graph skeleton review — 2026-06-02

## Scope reviewed

- `docs/internal/knowledge-graph-design-2026-06-02.md`
- `packages/core/src/types/knowledge.ts`
- Knowledge table additions in:
  - `packages/core/src/db/schema.sqlite.ts`
  - `packages/core/src/db/schema.postgres.ts`
  - `packages/core/src/db/schema.ts`
- Type barrel export in `packages/core/src/types/index.ts`

I did **not** review or extend services, MCP tools, or UI. I did not run
`pnpm build`, start dev processes, install dependencies, or generate migrations.

## Changes made during review

Small safe fixes applied:

1. Fixed a naming typo in the design doc from `kg_nodes` to `kb_graph_nodes`.
2. Added cross-dialect indexes that are likely to be needed by the first service
   layer and graph panels:
   - namespace lookup by `repo_id` / `branch_id`
   - document lookup by `created_by` and recent ordering via `updated_at`
   - document-unit ordering by `(version_id, ordinal)`
   - graph-node lookup for every nullable core-object FK, not only branch/session
   - graph-edge traversal by `(source_node_id, edge_type)` and
     `(target_node_id, edge_type)`
3. Re-checked the KB blocks in SQLite/Postgres after normalizing dialect-only
   differences (`text` vs `varchar`, `blob` vs `bytea`); no drift was detected.

## Findings and recommendations

### Must fix before merge / before enabling the feature

1. **No KB migrations exist yet.** The schema files define the new tables, but I
   found no `kb_*` SQL under `packages/core/drizzle/{sqlite,postgres}`. Before
   this can run anywhere, generate and review both SQLite and Postgres
   migrations. Do this with the normal Drizzle workflow when dependencies are
   available; I intentionally did not run generation here.

2. **Normalize namespace slugs, document paths, and URIs in the service layer.**
   The DB uniqueness is case-sensitive and accepts arbitrary text. Without a
   strict service contract, `Global/foo.md` and `global/foo.md`, `a//b.md`, or
   path traversal-like strings can become distinct rows while materializing to
   ambiguous future exports. Recommended invariant: service derives `uri` from
   normalized `namespace.slug` + normalized `document.path`; clients should not
   be trusted to provide canonical URIs.

3. **Search must scope units to the current version.** `kb_document_units` is
   versioned, so service-layer search should join through
   `kb_documents.current_version_id = kb_document_units.version_id` for current
   document search. Otherwise historical units from old versions will appear in
   search results.

4. **Private visibility must be enforced consistently across REST, MCP, and
   search.** V1 intentionally has only `visibility` / `edit_policy`, not full
   RBAC. That makes service hooks especially important: private documents should
   not leak through `/kb/search`, graph neighbor traversal, or MCP tools.

### Design / schema decisions to confirm

1. **Soft-delete uniqueness behavior.** Unique indexes on namespace slug,
   `(namespace_id, path)`, document `uri`, graph node `uri`, and edge
   `(source,target,type)` include archived rows. This means archiving does not
   free the name/link for reuse. That may be desirable for restore semantics, but
   it should be an explicit product decision. If users need “archive then create
   a new page at the same path,” this will need partial unique indexes or a
   service-level unarchive/replace flow.

2. **`current_version_id` is intentionally not a FK.** The comment explains this
   avoids a circular FK. Services should maintain it transactionally and reads
   should tolerate `null` / dangling values during partial failures or migration
   repair.

3. **Graph-node type/FK consistency is application-enforced.** The schema allows
   a row with multiple nullable core-object FKs or none at all. Services should
   enforce exactly the expected FK for each `node_type` and derive node URIs.

4. **Graph lifecycle on document edits needs a policy.** Version/unit nodes and
   their edges can remain for historical versions. Current-doc graph views should
   either filter through `current_version_id`, archive superseded unit nodes, or
   intentionally show versioned history.

5. **`confidence` is an integer.** If this is meant to be a 0–1 score, the schema
   should use a real/decimal representation or document that it is an integer
   scale such as 0–100 or basis points. Leaving it ambiguous will produce API
   drift later.

   Follow-up: documented and implemented as API `0..1`, DB integer basis points
   (`0..10000`).

6. **`edit_policy = public` exists in the schema while the design calls it a
   future wiki-like mode.** If public editing is not actually enabled in V1,
   service hooks should reject or ignore that value until the behavior is fully
   designed.

### Consistency notes

- Type names and schema names are consistent with the current split:
  user-facing “Knowledge”, TS interfaces prefixed `Knowledge*`, and DB tables
  prefixed `kb_*` / `kb_graph_*`.
- `packages/core/src/types/index.ts` exports `knowledge.ts`, and
  `packages/core/src/db/schema.ts` exports the KB tables from the runtime dialect.
- The dual-schema additions are currently in lockstep except for expected
  dialect-specific column helpers.
- The schema avoids SQLite `CHECK` constraints for enum-like columns, which is
  consistent with `context/guides/creating-database-migrations.md`.

## Suggested next steps

1. Generate SQLite and Postgres migrations and inspect the SQL carefully.
2. Add a small service-layer normalization helper before implementing CRUD.
3. In the first repository/service methods, encode the invariants above:
   derived URI, current-version search, visibility filtering, graph-node FK
   validation, and transactional version creation + current pointer update.
