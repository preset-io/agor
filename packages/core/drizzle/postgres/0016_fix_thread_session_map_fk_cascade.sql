-- Fix foreign key constraint on thread_session_map.session_id to add ON DELETE CASCADE
-- This allows sessions to be deleted without violating the foreign key constraint

-- Drop the existing foreign key constraint
ALTER TABLE "thread_session_map" DROP CONSTRAINT IF EXISTS "thread_session_map_session_id_sessions_session_id_fk";

-- Recreate the foreign key constraint with ON DELETE CASCADE
ALTER TABLE "thread_session_map" ADD CONSTRAINT "thread_session_map_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;
