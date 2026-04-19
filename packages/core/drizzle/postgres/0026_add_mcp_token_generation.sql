-- MCP token hardening: per-session generation counter.
-- See the matching sqlite migration for rationale.

ALTER TABLE "sessions" ADD COLUMN "mcp_token_generation" integer DEFAULT 0 NOT NULL;
