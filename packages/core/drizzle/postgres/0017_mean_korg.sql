CREATE TABLE IF NOT EXISTS "user_mcp_oauth_tokens" (
	"user_id" varchar(36) NOT NULL,
	"mcp_server_id" varchar(36) NOT NULL,
	"oauth_access_token" text NOT NULL,
	"oauth_token_expires_at" timestamp with time zone,
	"oauth_refresh_token" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_mcp_oauth_tokens" ADD CONSTRAINT "user_mcp_oauth_tokens_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_mcp_oauth_tokens" ADD CONSTRAINT "user_mcp_oauth_tokens_mcp_server_id_mcp_servers_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("mcp_server_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcp_oauth_tokens_pk" ON "user_mcp_oauth_tokens" USING btree ("user_id","mcp_server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcp_oauth_tokens_user_idx" ON "user_mcp_oauth_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcp_oauth_tokens_server_idx" ON "user_mcp_oauth_tokens" USING btree ("mcp_server_id");
