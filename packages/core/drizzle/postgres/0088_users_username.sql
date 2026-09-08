-- Local Disco accounts use a username, nickname, and password. The former
-- email column already contains the login identifier, so this is a lossless
-- metadata rename for existing installations.
ALTER TABLE "users" RENAME COLUMN "email" TO "username";--> statement-breakpoint
ALTER INDEX IF EXISTS "users_email_idx" RENAME TO "users_username_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "users_tenant_email_unique" RENAME TO "users_tenant_username_unique";
