-- Database bootstrap, part 1 of 2: cluster-level roles. Run by a superuser
-- (scripts/bootstrap-roles.ts does this).
--
--   garage_owner  owns every table; used ONLY to run migrations.
--   garage_app    used by the running application; receives explicit, minimal grants per table
--                 in each migration. It cannot create, alter or drop anything.
--
-- The password placeholders below are substituted (and escaped) by src/server/db/bootstrap.ts.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garage_owner') THEN
    CREATE ROLE garage_owner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garage_app') THEN
    CREATE ROLE garage_app LOGIN;
  END IF;
END
$$;

ALTER ROLE garage_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :owner_password;
ALTER ROLE garage_app   WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :app_password;
