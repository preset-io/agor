CREATE TABLE "groups" (
  "group_id" varchar(36) PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "archived" boolean DEFAULT false NOT NULL,
  "created_by" varchar(36),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "groups_slug_idx" ON "groups" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX "groups_archived_idx" ON "groups" USING btree ("archived");
--> statement-breakpoint
CREATE TABLE "group_memberships" (
  "group_id" varchar(36) NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "added_by" varchar(36),
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "group_memberships_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("group_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_added_by_users_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "group_memberships_user_idx" ON "group_memberships" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "branch_group_grants" (
  "branch_id" varchar(36) NOT NULL,
  "group_id" varchar(36) NOT NULL,
  "can" text DEFAULT 'view' NOT NULL,
  "fs_access" text,
  "created_by" varchar(36),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone,
  CONSTRAINT "branch_group_grants_branch_id_group_id_pk" PRIMARY KEY("branch_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "branch_group_grants" ADD CONSTRAINT "branch_group_grants_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("branch_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "branch_group_grants" ADD CONSTRAINT "branch_group_grants_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("group_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "branch_group_grants" ADD CONSTRAINT "branch_group_grants_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "branch_group_grants_group_idx" ON "branch_group_grants" USING btree ("group_id");
