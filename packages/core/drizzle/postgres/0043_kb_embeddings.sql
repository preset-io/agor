CREATE TABLE IF NOT EXISTS "kb_embedding_spaces" (
  "embedding_space_id" varchar(36) PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "dimensions" integer NOT NULL,
  "storage_type" text DEFAULT 'vector' NOT NULL,
  "distance" text DEFAULT 'cosine' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_embedding_spaces_provider_model_idx" ON "kb_embedding_spaces" USING btree ("provider","model","dimensions","storage_type","distance");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_embedding_spaces_active_idx" ON "kb_embedding_spaces" USING btree ("active");
