-- Ensure pg_net is enabled so we can create Webhooks
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create or replace your webhook trigger on the "uploads" table.
-- This will make a POST request with the inserted row to your Edge Function.
CREATE TRIGGER uploads 
AFTER INSERT ON public.uploads 
FOR EACH ROW 
EXECUTE FUNCTION supabase_functions.http_request(
    'https://db.unlinked.ai/functions/v1/process-uploads',
    'POST',
    '{
        "Content-type": "application/json",
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZybm5oaWZ5ZXZtZmtheW9lbnlrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNTA5MzQwMCwiZXhwIjoyMDUwNjY5NDAwfQ.ZLIj0Ue6wm64Ba3Ml7i5AMZnSX7U6NJk19AqCKVZ6Iw"
    }',
    '{}',
    '10000'
);

-- Grant service_role permission to manage tables with RLS in the public schema.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
