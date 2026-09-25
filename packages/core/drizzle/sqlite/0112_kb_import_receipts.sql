CREATE TABLE "kb_import_receipts" (
 "receipt_id" text PRIMARY KEY NOT NULL,
 "owner_user_id" text NOT NULL,
 "bundle" text NOT NULL,
 "slug" text NOT NULL,
 "entry_key" text NOT NULL,
 "target_id" text NOT NULL,
 "digest" text NOT NULL,
 "request_bytes" integer DEFAULT 0 NOT NULL,
 "reconciled_count" integer DEFAULT -1 NOT NULL,
 "created_at" integer NOT NULL,
 CONSTRAINT "kb_import_receipts_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("user_id") ON DELETE CASCADE 
);
--> statement-breakpoint
CREATE UNIQUE INDEX "kb_import_receipts_identity_unique" ON "kb_import_receipts" ("owner_user_id", "bundle", "slug", "entry_key");
