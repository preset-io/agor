ALTER TABLE `boards` ADD `primary_assistant_id` text(36) REFERENCES branches(branch_id) ON DELETE set null;--> statement-breakpoint
WITH assistant_counts AS (
  SELECT
    board_id,
    COUNT(*) AS assistant_count,
    MIN(branch_id) AS branch_id
  FROM branches
  WHERE board_id IS NOT NULL
    AND (
      json_extract(data, '$.custom_context.assistant.kind') IN ('assistant', 'persisted-agent')
      OR json_extract(data, '$.custom_context.agent.kind') IN ('assistant', 'persisted-agent')
    )
  GROUP BY board_id
)
UPDATE boards
SET primary_assistant_id = (
  SELECT branch_id
  FROM assistant_counts
  WHERE assistant_counts.board_id = boards.board_id
    AND assistant_counts.assistant_count = 1
)
WHERE primary_assistant_id IS NULL
  AND board_id IN (
    SELECT board_id
    FROM assistant_counts
    WHERE assistant_count = 1
  );
