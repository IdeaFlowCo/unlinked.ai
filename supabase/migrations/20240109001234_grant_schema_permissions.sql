-- Grants usage on public schema to authenticated role
grant usage on schema public to authenticated;

-- Ensures select access on all existing tables in schema public
grant select on all tables in schema public to authenticated;

-- Ensures future tables in public schema also grant select
alter default privileges in schema public grant select on tables to authenticated;
