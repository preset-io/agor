CREATE TABLE "agor_pack_imports" (
 "import_id" text PRIMARY KEY NOT NULL,
 "owner_user_id" text NOT NULL,
 "content_sha256" text NOT NULL,
 "staging_ref" text,
 "status" text NOT NULL,
 "manifest" text NOT NULL,
 "dry_run" text,
 "results" text,
 "error" text,
 "created_at" integer NOT NULL,
 "updated_at" integer NOT NULL,
 "applied_at" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agor_pack_imports_content_unique" ON "agor_pack_imports" ("owner_user_id", "content_sha256");
