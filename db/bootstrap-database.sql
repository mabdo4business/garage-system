-- Database bootstrap, part 2 of 2: per-database lockdown. Run by a superuser connected to the
-- target database, after db/bootstrap.sql. The database placeholder is substituted (and
-- escaped) by src/server/db/bootstrap.ts.

REVOKE ALL ON DATABASE :database FROM PUBLIC;
GRANT CONNECT ON DATABASE :database TO garage_owner, garage_app;

ALTER SCHEMA public OWNER TO garage_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO garage_app;
