ALTER TABLE "artifact_trust_grants" ADD COLUMN "artifact_hash" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifact_trust_grants" ADD COLUMN "allow_introspection" boolean DEFAULT false NOT NULL;
