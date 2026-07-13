CREATE TABLE "links" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"link_id" varchar(36) PRIMARY KEY NOT NULL,
	"branch_id" varchar(36),
	"session_id" varchar(36),
	"source_message_id" varchar(36),
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"ref_uri" text,
	"file_path" text,
	"target_object_type" text,
	"target_object_id" varchar(36),
	"target_key" text NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"title" text,
	"mime_type" text,
	"metadata" jsonb,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "links_owner_xor_check" CHECK ((("branch_id" is not null) and ("session_id" is null)) or (("branch_id" is null) and ("session_id" is not null))),
	CONSTRAINT "links_target_xor_check" CHECK ((case when "url" is not null and trim("url") <> '' then 1 else 0 end + case when "ref_uri" is not null and trim("ref_uri") <> '' then 1 else 0 end + case when "file_path" is not null and trim("file_path") <> '' then 1 else 0 end) = 1),
	CONSTRAINT "links_target_object_pair_check" CHECK ((("target_object_type" is null) and ("target_object_id" is null)) or (("target_object_type" is not null) and ("target_object_id" is not null)))
);
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("branch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_source_message_id_messages_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("message_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "links_tenant_id_idx" ON "links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "links_branch_id_idx" ON "links" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "links_session_id_idx" ON "links" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "links_source_message_id_idx" ON "links" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "links_target_object_idx" ON "links" USING btree ("tenant_id","target_object_type","target_object_id");--> statement-breakpoint
CREATE INDEX "links_branch_pinned_idx" ON "links" USING btree ("tenant_id","branch_id","is_pinned");--> statement-breakpoint
CREATE INDEX "links_session_pinned_idx" ON "links" USING btree ("tenant_id","session_id","is_pinned");--> statement-breakpoint
CREATE UNIQUE INDEX "links_branch_target_idx" ON "links" USING btree ("tenant_id","branch_id","target_key") WHERE "links"."branch_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "links_session_target_idx" ON "links" USING btree ("tenant_id","session_id","target_key") WHERE "links"."session_id" is not null;--> statement-breakpoint
ALTER TABLE "links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_links" ON "links";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_links" ON "links"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
