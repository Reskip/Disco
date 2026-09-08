ALTER TABLE "uploads" ADD COLUMN "agent_id" varchar(36);--> statement-breakpoint
UPDATE "uploads" AS u
SET "agent_id" = s."agent_id"
FROM "sessions" AS s
WHERE s."session_id" = u."session_id"
  AND s."tenant_id" = u."tenant_id";--> statement-breakpoint
ALTER TABLE "uploads" DROP COLUMN "branch_id";
