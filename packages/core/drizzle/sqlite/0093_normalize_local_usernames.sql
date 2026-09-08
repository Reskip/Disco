-- Remove the remaining email-shaped presentation inherited from older local
-- accounts. Prefer the unique local part; use a deterministic user-id fallback
-- whenever that local part is invalid or already occupied.
WITH `candidates` AS (
  SELECT
    `user_id`,
    LOWER(SUBSTR(`username`, 1, INSTR(`username`, '@') - 1)) AS `base`
  FROM `users`
  WHERE INSTR(`username`, '@') > 0
),
`resolved` AS (
  SELECT
    `candidate`.`user_id`,
    CASE
      WHEN LENGTH(`candidate`.`base`) BETWEEN 2 AND 55
        AND SUBSTR(`candidate`.`base`, 1, 1) GLOB '[a-z0-9]'
        AND `candidate`.`base` NOT GLOB '*[^a-z0-9._-]*'
        AND 1 = (
          SELECT COUNT(*)
          FROM `candidates` `duplicate`
          WHERE `duplicate`.`base` = `candidate`.`base`
        )
        AND NOT EXISTS (
          SELECT 1
          FROM `users` `existing`
          WHERE LOWER(`existing`.`username`) = `candidate`.`base`
            AND `existing`.`user_id` <> `candidate`.`user_id`
        )
      THEN `candidate`.`base`
      ELSE 'legacy-' || SUBSTR(REPLACE(`candidate`.`user_id`, '-', ''), 1, 32)
    END AS `username`
  FROM `candidates` `candidate`
)
UPDATE `users`
SET `username` = (
  SELECT `resolved`.`username`
  FROM `resolved`
  WHERE `resolved`.`user_id` = `users`.`user_id`
)
WHERE `user_id` IN (SELECT `user_id` FROM `resolved`);
