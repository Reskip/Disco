-- Development-only bootstrap for Disco's PostgreSQL profile.
--
-- POSTGRES_USER from the official image remains a bootstrap superuser. Disco's
-- app connects as disco_app, a non-superuser, so PostgreSQL RLS is exercised in
-- local/dev environments instead of being silently bypassed.

CREATE ROLE disco_app
  LOGIN
  PASSWORD 'disco_dev_secret'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;

GRANT CONNECT, TEMPORARY, CREATE ON DATABASE disco TO disco_app;

-- Let Drizzle create and mutate objects without making the runtime role a
-- superuser. Future app-created objects are owned by disco_app; RLS migrations
-- also FORCE ROW LEVEL SECURITY so the owner is still subject to tenant
-- policies.
ALTER SCHEMA public OWNER TO disco_app;
GRANT ALL ON SCHEMA public TO disco_app;

CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION disco_app;
GRANT ALL ON SCHEMA drizzle TO disco_app;

ALTER DEFAULT PRIVILEGES FOR ROLE disco_app IN SCHEMA public GRANT ALL ON TABLES TO disco_app;
ALTER DEFAULT PRIVILEGES FOR ROLE disco_app IN SCHEMA public GRANT ALL ON SEQUENCES TO disco_app;
ALTER DEFAULT PRIVILEGES FOR ROLE disco_app IN SCHEMA public GRANT ALL ON FUNCTIONS TO disco_app;

ALTER DEFAULT PRIVILEGES FOR ROLE disco_app IN SCHEMA drizzle GRANT ALL ON TABLES TO disco_app;
ALTER DEFAULT PRIVILEGES FOR ROLE disco_app IN SCHEMA drizzle GRANT ALL ON SEQUENCES TO disco_app;
ALTER DEFAULT PRIVILEGES FOR ROLE disco_app IN SCHEMA drizzle GRANT ALL ON FUNCTIONS TO disco_app;
