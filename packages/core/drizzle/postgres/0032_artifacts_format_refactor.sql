-- Artifacts format refactor (2026-05-09).
--
-- See the matching sqlite migration and
-- `docs/internal/artifacts-roadmap-2026-05-09.md` for the rationale.
-- Backwards compatibility is intentionally NOT preserved; old rows get
-- empty defaults and the daemon surfaces a self-service upgrade prompt.

ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "use_local_bundler";--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "sandpack_config" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "required_env_vars" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "agor_grants" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint

CREATE TABLE "artifact_trust_grants" (
	"grant_id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"scope_type" text NOT NULL,
	"scope_value" text,
	"env_vars_set" jsonb NOT NULL,
	"agor_grants_set" jsonb NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "artifact_trust_grants" ADD CONSTRAINT "artifact_trust_grants_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "artifact_trust_grants_user_idx" ON "artifact_trust_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "artifact_trust_grants_scope_idx" ON "artifact_trust_grants" USING btree ("scope_type", "scope_value");
