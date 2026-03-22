CREATE TABLE "card_types" (
	"card_type_id" varchar(36) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"emoji" text,
	"color" text,
	"json_schema" text,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"card_id" varchar(36) PRIMARY KEY NOT NULL,
	"board_id" varchar(36) NOT NULL,
	"card_type_id" varchar(36),
	"title" text NOT NULL,
	"url" text,
	"description" text,
	"note" text,
	"data" text,
	"color_override" text,
	"emoji_override" text,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "board_objects" ALTER COLUMN "worktree_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "board_objects" ADD COLUMN "card_id" varchar(36);--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_card_type_id_card_types_card_type_id_fk" FOREIGN KEY ("card_type_id") REFERENCES "public"."card_types"("card_type_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_types_name_idx" ON "card_types" USING btree ("name");--> statement-breakpoint
CREATE INDEX "cards_board_idx" ON "cards" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "cards_card_type_idx" ON "cards" USING btree ("card_type_id");--> statement-breakpoint
CREATE INDEX "cards_title_idx" ON "cards" USING btree ("title");--> statement-breakpoint
CREATE INDEX "cards_archived_idx" ON "cards" USING btree ("archived");--> statement-breakpoint
CREATE INDEX "cards_created_idx" ON "cards" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "board_objects" ADD CONSTRAINT "board_objects_card_id_cards_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("card_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_objects_card_idx" ON "board_objects" USING btree ("card_id");