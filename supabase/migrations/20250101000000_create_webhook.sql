-- Ensure pg_net is enabled so we can create Webhooks
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create or replace your webhook trigger on the "uploads" table.
-- This will make a POST request with the inserted row to your Edge Function.
--
-- SECURITY: the Authorization header below previously contained a live
-- service_role JWT, checked into a PUBLIC repository. It was removed from
-- source on 2026-09-17; the key leaked in public repo history and MUST be
-- rotated (Supabase dashboard -> Project Settings -> API -> service_role).
-- Rotating the key does not require re-running this migration: update the
-- trigger's header in the dashboard / via a manual statement instead. Do NOT
-- add a new migration that re-executes this statement with a real key.
CREATE TRIGGER uploads 
AFTER INSERT ON public.uploads 
FOR EACH ROW 
EXECUTE FUNCTION supabase_functions.http_request(
    'https://db.unlinked.ai/functions/v1/process-uploads',
    'POST',
    '{
        "Content-type": "application/json",
        "Authorization": "Bearer SERVICE_ROLE_KEY_PLACEHOLDER_SET_IN_DASHBOARD"
    }',
    '{}',
    '10000'
);

-- Grant service_role permission to manage tables with RLS in the public schema.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
