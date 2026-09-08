ALTER TABLE "branches" ALTER COLUMN "repo_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_directory_owner_name_unique"
ON "branches" ("created_by", "name")
WHERE "repo_id" IS NULL AND "storage_mode" = 'directory' AND "archived" = false;--> statement-breakpoint
UPDATE "branches"
SET "repo_id" = NULL
WHERE "storage_mode" = 'directory';--> statement-breakpoint
DELETE FROM "repos"
WHERE "slug" = 'disco/workspaces'
  AND NOT EXISTS (
    SELECT 1 FROM "branches" WHERE "branches"."repo_id" = "repos"."repo_id"
  );
