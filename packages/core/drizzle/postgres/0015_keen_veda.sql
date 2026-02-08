DROP INDEX "uniq_thread_map_channel_thread";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_thread_map_channel_thread" ON "thread_session_map" USING btree ("channel_id","thread_id");