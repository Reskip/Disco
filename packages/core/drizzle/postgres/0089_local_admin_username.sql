-- The old bootstrap identifier looked like an email address. Disco accounts
-- are local username/password identities, so migrate it per tenant whenever
-- the concise username is still available.
UPDATE "users" AS "target"
SET "username" = 'admin'
WHERE lower("target"."username") = 'admin@disco.live'
  AND NOT EXISTS (
    SELECT 1
    FROM "users" AS "existing"
    WHERE "existing"."tenant_id" = "target"."tenant_id"
      AND lower("existing"."username") = 'admin'
  );
