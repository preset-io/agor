-- Backfill unix_username for existing sessions
-- Sets session.unix_username from creator's current unix_username

UPDATE sessions
SET unix_username = (
  SELECT unix_username
  FROM users
  WHERE user_id = sessions.created_by
)
WHERE unix_username IS NULL;
