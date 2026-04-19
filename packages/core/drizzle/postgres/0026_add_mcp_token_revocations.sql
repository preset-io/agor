-- MCP token hardening: add jti/exp/gen + revocation ledger.
-- See the matching sqlite migration (`0037_add_mcp_token_revocations.sql`)
-- for rationale.

ALTER TABLE "sessions" ADD COLUMN "mcp_token_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE "mcp_token_revocations" (
	"jti" text PRIMARY KEY NOT NULL,
	"session_id" varchar(36),
	"revoked_at" bigint NOT NULL,
	"revoked_by" text,
	"reason" text NOT NULL,
	"expires_at" bigint NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mcp_token_revocations_session_idx" ON "mcp_token_revocations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_token_revocations_expires_idx" ON "mcp_token_revocations" USING btree ("expires_at");
