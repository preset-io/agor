CREATE TABLE "board_owners" (
  "board_id" varchar(36) NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "created_at" timestamp with time zone,
  CONSTRAINT "board_owners_board_id_user_id_pk" PRIMARY KEY("board_id","user_id"),
  CONSTRAINT "board_owners_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "boards"("board_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "board_owners_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "board_owners_user_idx" ON "board_owners" ("user_id");
