ALTER TABLE "boards" ADD COLUMN "primary_assistant_id" varchar(36);--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_primary_assistant_id_branches_branch_id_fk" FOREIGN KEY ("primary_assistant_id") REFERENCES "public"."branches"("branch_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
WITH assistant_counts AS (
  SELECT
    board_id,
    COUNT(*) AS assistant_count,
    MIN(branch_id) AS branch_id
  FROM branches
  WHERE board_id IS NOT NULL
    AND (
      data->'custom_context'->'assistant'->>'kind' IN ('assistant', 'persisted-agent')
      OR data->'custom_context'->'agent'->>'kind' IN ('assistant', 'persisted-agent')
    )
  GROUP BY board_id
)
UPDATE boards
SET primary_assistant_id = assistant_counts.branch_id
FROM assistant_counts
WHERE boards.primary_assistant_id IS NULL
  AND boards.board_id = assistant_counts.board_id
  AND assistant_counts.assistant_count = 1;
