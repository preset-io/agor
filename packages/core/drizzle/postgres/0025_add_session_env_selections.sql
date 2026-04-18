-- Session Env Selections table (v0.5 env-var-access)
--
-- See the matching sqlite migration + `context/explorations/env-var-access.md`
-- for the full rationale. No CHECK constraint on any column so adding future
-- scope values in `users.data.env_vars` stays schema-free.
CREATE TABLE "session_env_selections" (
	"session_id" varchar(36) NOT NULL,
	"env_var_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_env_selections_session_id_env_var_name_pk" PRIMARY KEY ("session_id","env_var_name")
);--> statement-breakpoint

ALTER TABLE "session_env_selections" ADD CONSTRAINT "session_env_selections_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "session_env_selections_session_idx" ON "session_env_selections" USING btree ("session_id");
