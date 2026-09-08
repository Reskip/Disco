ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_branch_id_branches_branch_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "branch_id" DROP NOT NULL;
