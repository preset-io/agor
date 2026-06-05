CREATE TABLE "app_variables" (
  "variable_id" varchar(36) PRIMARY KEY NOT NULL,
  "namespace" text NOT NULL,
  "key" text NOT NULL,
  "value_text" text,
  "value_encrypted" text,
  "is_encrypted" boolean DEFAULT false NOT NULL,
  "content_type" text DEFAULT 'text/plain' NOT NULL,
  "metadata" jsonb,
  "updated_by" varchar(36),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "app_variables_updated_by_users_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_variables_namespace_key_idx" ON "app_variables" USING btree ("namespace","key");
--> statement-breakpoint
CREATE INDEX "app_variables_namespace_idx" ON "app_variables" USING btree ("namespace");
