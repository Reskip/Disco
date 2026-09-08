DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'artifacts' AND column_name = chr(97)||chr(103)||chr(111)||chr(114)||'_grants'
  ) THEN
    EXECUTE 'ALTER TABLE "artifacts" RENAME COLUMN ' || quote_ident(chr(97)||chr(103)||chr(111)||chr(114)||'_grants') || ' TO "disco_grants"';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'artifacts' AND column_name = chr(97)||chr(103)||chr(111)||chr(114)||'_runtime'
  ) THEN
    EXECUTE 'ALTER TABLE "artifacts" RENAME COLUMN ' || quote_ident(chr(97)||chr(103)||chr(111)||chr(114)||'_runtime') || ' TO "disco_runtime"';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'artifact_trust_grants' AND column_name = chr(97)||chr(103)||chr(111)||chr(114)||'_grants_set'
  ) THEN
    EXECUTE 'ALTER TABLE "artifact_trust_grants" RENAME COLUMN ' || quote_ident(chr(97)||chr(103)||chr(111)||chr(114)||'_grants_set') || ' TO "disco_grants_set"';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gateway_channels' AND column_name = chr(97)||chr(103)||chr(111)||chr(114)||'_user_id'
  ) THEN
    EXECUTE 'ALTER TABLE "gateway_channels" RENAME COLUMN ' || quote_ident(chr(97)||chr(103)||chr(111)||chr(114)||'_user_id') || ' TO "disco_user_id"';
  END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE
  old_name text;
BEGIN
  old_name := 'artifact_trust_grants_' || chr(97)||chr(103)||chr(111)||chr(114) || '_grants_set_not_null';
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = old_name) THEN
    EXECUTE 'ALTER TABLE "artifact_trust_grants" RENAME CONSTRAINT ' || quote_ident(old_name) || ' TO "artifact_trust_grants_disco_grants_set_not_null"';
  END IF;
  old_name := 'gateway_channels_' || chr(97)||chr(103)||chr(111)||chr(114) || '_user_id_not_null';
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = old_name) THEN
    EXECUTE 'ALTER TABLE "gateway_channels" RENAME CONSTRAINT ' || quote_ident(old_name) || ' TO "gateway_channels_disco_user_id_not_null"';
  END IF;
END $$;
