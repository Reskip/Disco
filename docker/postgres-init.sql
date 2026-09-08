-- PostgreSQL initialization script for Disco development
-- This grants the necessary permissions for the disco user to run Drizzle migrations

-- Make disco user a superuser for development (simplifies permissions)
-- In production, use granular permissions instead
ALTER USER disco WITH SUPERUSER;

-- Grant all permissions on the public schema (required for PostgreSQL 15+)
GRANT ALL ON SCHEMA public TO disco;

-- Pre-create the drizzle schema (used by Drizzle ORM for migration tracking)
CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT ALL ON SCHEMA drizzle TO disco;

-- Grant all default privileges for future objects in both schemas
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO disco;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO disco;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO disco;

ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL ON TABLES TO disco;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL ON SEQUENCES TO disco;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL ON FUNCTIONS TO disco;
