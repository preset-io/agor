-- Retire the database-backed MCP catalog.
--
-- The catalog is served from `curated.yaml`, checked into the repository and
-- loaded in process, so there is nothing here to preserve: every column was
-- either a copy of that file or a cached observation of a public endpoint, and
-- both are reproduced on the next daemon start. Dropping the table also drops
-- its RLS policies and indexes.
DROP TABLE IF EXISTS "mcp_catalog_entries";
