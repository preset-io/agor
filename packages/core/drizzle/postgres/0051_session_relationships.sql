CREATE TABLE "session_relationships" (
	"relationship_id" varchar(36) PRIMARY KEY NOT NULL,
	"source_session_id" varchar(36) NOT NULL,
	"target_session_id" varchar(36) NOT NULL,
	"relationship_type" text NOT NULL,
	"created_by" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"callback_enabled" boolean DEFAULT false NOT NULL,
	"callback_session_id" varchar(36),
	"data" jsonb
);
--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_source_session_id_sessions_session_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_target_session_id_sessions_session_id_fk" FOREIGN KEY ("target_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_callback_session_id_sessions_session_id_fk" FOREIGN KEY ("callback_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "session_relationships_source_idx" ON "session_relationships" USING btree ("source_session_id");
--> statement-breakpoint
CREATE INDEX "session_relationships_target_idx" ON "session_relationships" USING btree ("target_session_id");
--> statement-breakpoint
CREATE INDEX "session_relationships_callback_idx" ON "session_relationships" USING btree ("callback_session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "session_relationships_source_target_type_unique" ON "session_relationships" USING btree ("source_session_id","target_session_id","relationship_type");
