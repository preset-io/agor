CREATE TABLE "board_group_grants" (
  "board_id" varchar(36) NOT NULL,
  "group_id" varchar(36) NOT NULL,
  "can" text DEFAULT 'view' NOT NULL,
  "fs_access" text,
  "created_by" varchar(36),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone,
  CONSTRAINT "board_group_grants_board_id_group_id_pk" PRIMARY KEY("board_id","group_id"),
  CONSTRAINT "board_group_grants_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "boards"("board_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "board_group_grants_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "groups"("group_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "board_group_grants_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "board_group_grants_group_idx" ON "board_group_grants" ("group_id");
