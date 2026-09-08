-- Local Disco accounts use a username, nickname, and password. The former
-- email column already contains the login identifier, so this is a lossless
-- metadata rename for existing installations.
ALTER TABLE `users` RENAME COLUMN `email` TO `username`;--> statement-breakpoint
DROP INDEX IF EXISTS `users_email_idx`;--> statement-breakpoint
CREATE INDEX `users_username_idx` ON `users` (`username`);
