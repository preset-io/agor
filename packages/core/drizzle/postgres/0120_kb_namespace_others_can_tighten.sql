SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Drop FORCE RLS so the owning migrate role normalizes every tenant; restored below.
ALTER TABLE "kb_namespaces" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Owned, personal, branch (teammate) and private-default namespaces stop inheriting the old
-- write-for-everyone fallback. Ownerless shared spaces (such as global and skills) keep it.
UPDATE "kb_namespaces"
SET "others_can" = CASE WHEN "visibility_default" = 'private' THEN 'none' ELSE 'read' END
WHERE "others_can" = 'write'
  AND (
    "owner_user_id" IS NOT NULL
    OR "kind" IN ('user', 'branch')
    OR "visibility_default" = 'private'
  );
--> statement-breakpoint
ALTER TABLE "kb_namespaces" FORCE ROW LEVEL SECURITY;
