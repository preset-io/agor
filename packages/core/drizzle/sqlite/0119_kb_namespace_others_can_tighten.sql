-- Owned, personal, branch (teammate) and private-default namespaces stop inheriting the old
-- write-for-everyone fallback. Ownerless shared spaces (such as global and skills) keep it.
UPDATE `kb_namespaces`
SET `others_can` = CASE WHEN `visibility_default` = 'private' THEN 'none' ELSE 'read' END
WHERE `others_can` = 'write'
  AND (
    `owner_user_id` IS NOT NULL
    OR `kind` IN ('user', 'branch')
    OR `visibility_default` = 'private'
  );
