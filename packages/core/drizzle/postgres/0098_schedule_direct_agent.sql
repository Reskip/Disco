-- Remove the final active Branch carrier from the Schedule model. Existing
-- definitions become standalone schedules; no compatibility API or dual-write
-- path is retained.
ALTER TABLE "sessions" RENAME COLUMN "scheduled_from_branch" TO "is_scheduled";--> statement-breakpoint
DROP INDEX IF EXISTS "schedules_branch_idx";--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT IF EXISTS "schedules_branch_id_branches_branch_id_fk";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "branch_id";--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "agent_id" varchar(36);--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_agent_idx" ON "schedules" ("agent_id");
