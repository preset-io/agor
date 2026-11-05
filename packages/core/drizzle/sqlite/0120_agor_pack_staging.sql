ALTER TABLE "agor_pack_imports" ADD "progress" text;
--> statement-breakpoint
ALTER TABLE "agor_pack_imports" ADD "claim_token" text;
--> statement-breakpoint
ALTER TABLE "agor_pack_imports" ADD "claimed_at" integer;
--> statement-breakpoint
CREATE TABLE "staged_blobs" (
 "blob_ref" text PRIMARY KEY NOT NULL,
 "kind" text NOT NULL,
 "scope_id" text NOT NULL,
 "created_by" text NOT NULL,
 "size_bytes" integer NOT NULL,
 "status" text NOT NULL,
 "created_at" integer NOT NULL,
 "expires_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "staged_blobs_scope_idx" ON "staged_blobs" ("kind", "scope_id");
--> statement-breakpoint
CREATE INDEX "staged_blobs_expiry_idx" ON "staged_blobs" ("expires_at");
