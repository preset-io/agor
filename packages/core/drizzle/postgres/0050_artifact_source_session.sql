ALTER TABLE "artifacts" ADD COLUMN "source_session_id" varchar(36);--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_source_session_id_sessions_session_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_source_session_idx" ON "artifacts" USING btree ("source_session_id");
