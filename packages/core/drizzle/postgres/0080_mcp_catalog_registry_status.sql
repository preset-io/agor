-- Registry lifecycle state, promoted out of the `data` blob so the browse read
-- can exclude withdrawn servers in SQL. A blob key cannot be filtered, so a
-- retired curated row still matched every query and still sorted first.
ALTER TABLE "mcp_catalog_entries" ADD COLUMN "registry_status" text;

-- Backfill from the blob so existing rows keep their state.
UPDATE "mcp_catalog_entries"
SET "registry_status" = "data"->>'registry_status'
WHERE "data" ? 'registry_status';

CREATE INDEX "mcp_catalog_entries_registry_status_idx"
  ON "mcp_catalog_entries" ("registry_status");
