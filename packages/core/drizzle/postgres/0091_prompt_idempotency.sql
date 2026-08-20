-- Keep caller-generated prompt retry identities separate from server Task IDs.
ALTER TABLE "tasks" ADD COLUMN "prompt_idempotency_key" varchar(36);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "prompt_request_fingerprint" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_prompt_idempotency_unique" ON "tasks" USING btree ("tenant_id","created_by","session_id","prompt_idempotency_key") WHERE "tasks"."prompt_idempotency_key" IS NOT NULL;
