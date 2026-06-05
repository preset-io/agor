CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "kb_embedding_spaces" (
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
CREATE UNIQUE INDEX "kb_embedding_spaces_provider_model_idx" ON "kb_embedding_spaces" USING btree ("provider","model","dimensions","storage_type","distance");
--> statement-breakpoint
CREATE INDEX "kb_embedding_spaces_active_idx" ON "kb_embedding_spaces" USING btree ("active");
--> statement-breakpoint
CREATE TABLE "kb_unit_embeddings" (
  "unit_id" varchar(36) NOT NULL,
  "embedding_space_id" varchar(36) NOT NULL,
  "content_sha256" text NOT NULL,
  "embedding" vector NOT NULL,
  "token_count" integer,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "kb_unit_embeddings_unit_id_embedding_space_id_pk" PRIMARY KEY("unit_id","embedding_space_id"),
  CONSTRAINT "kb_unit_embeddings_unit_id_kb_document_units_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."kb_document_units"("unit_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "kb_unit_embeddings_embedding_space_id_kb_embedding_spaces_embedding_space_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."kb_embedding_spaces"("embedding_space_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "kb_unit_embeddings_space_idx" ON "kb_unit_embeddings" USING btree ("embedding_space_id");
--> statement-breakpoint
CREATE INDEX "kb_unit_embeddings_embedding_1536_hnsw_idx" ON "kb_unit_embeddings" USING hnsw (("embedding"::vector(1536)) vector_cosine_ops) WHERE vector_dims("embedding") = 1536;
