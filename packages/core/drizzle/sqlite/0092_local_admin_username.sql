-- The old bootstrap identifier looked like an email address. Disco accounts
-- are local username/password identities, so migrate the built-in account to
-- the concise username when that name is still available.
UPDATE `users`
SET `username` = 'admin'
WHERE lower(`username`) = 'admin@disco.live'
  AND NOT EXISTS (
    SELECT 1 FROM `users` AS `existing`
    WHERE lower(`existing`.`username`) = 'admin'
  );
