CREATE TABLE "user_api_keys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "user_api_keys_user_idx" ON "user_api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_api_keys_prefix_idx" ON "user_api_keys" USING btree ("prefix");
