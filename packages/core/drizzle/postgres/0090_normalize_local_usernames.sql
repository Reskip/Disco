-- Remove the remaining email-shaped presentation inherited from older local
-- accounts. Prefer the unique local part; use a deterministic user-id fallback
-- whenever that local part is invalid or already occupied in the tenant.
WITH "candidates" AS (
  SELECT
    "user_id",
    "tenant_id",
    LOWER(SPLIT_PART("username", '@', 1)) AS "base"
  FROM "users"
  WHERE POSITION('@' IN "username") > 0
),
"resolved" AS (
  SELECT
    "candidate"."user_id",
    CASE
      WHEN LENGTH("candidate"."base") BETWEEN 2 AND 55
        AND "candidate"."base" ~ '^[a-z0-9][a-z0-9._-]*$'
        AND 1 = (
          SELECT COUNT(*)
          FROM "candidates" "duplicate"
          WHERE "duplicate"."tenant_id" = "candidate"."tenant_id"
            AND "duplicate"."base" = "candidate"."base"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "users" "existing"
          WHERE "existing"."tenant_id" = "candidate"."tenant_id"
            AND LOWER("existing"."username") = "candidate"."base"
            AND "existing"."user_id" <> "candidate"."user_id"
        )
      THEN "candidate"."base"
      ELSE 'legacy-' || LEFT(REPLACE("candidate"."user_id", '-', ''), 32)
    END AS "username"
  FROM "candidates" "candidate"
)
UPDATE "users" "target"
SET "username" = "resolved"."username"
FROM "resolved"
WHERE "target"."user_id" = "resolved"."user_id";
