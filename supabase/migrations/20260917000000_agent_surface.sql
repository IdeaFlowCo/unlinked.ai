-- Agent surface: API keys for programmatic (agent) access, plus embedding
-- bookkeeping on profiles.
--
-- Strictly additive. Nothing here drops, renames, or rewrites existing data.
--
-- agent_keys stores only a sha256 hash of each key. The plaintext key
-- (`ul_` + 32 random bytes, base64url) is shown to the user exactly once at
-- creation time and is never recoverable afterwards.
--
-- RLS: owner-only. anon gets nothing. The bearer-token lookup in the app runs
-- through the service_role client, which bypasses RLS by design -- that lookup
-- is the only path that can read a row by key_hash without already knowing the
-- owning user.

CREATE TABLE IF NOT EXISTS public.agent_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_keys_user_id ON public.agent_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_agent_keys_key_hash ON public.agent_keys (key_hash);

ALTER TABLE public.agent_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own agent keys" ON public.agent_keys;
CREATE POLICY "Users can view their own agent keys"
    ON public.agent_keys FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create their own agent keys" ON public.agent_keys;
CREATE POLICY "Users can create their own agent keys"
    ON public.agent_keys FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own agent keys" ON public.agent_keys;
CREATE POLICY "Users can update their own agent keys"
    ON public.agent_keys FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own agent keys" ON public.agent_keys;
CREATE POLICY "Users can delete their own agent keys"
    ON public.agent_keys FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- The earlier RLS migration ran a blanket
-- `GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon`, which only covered
-- tables existing at that time. Be explicit that anon gets nothing here.
REVOKE ALL ON public.agent_keys FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_keys TO authenticated;
GRANT ALL ON public.agent_keys TO service_role;

-- Embedding bookkeeping. NULL means "never embedded"; the /api/cron/embed
-- pull job claims batches of NULL rows and stamps this column on success.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_embedded_at_null
    ON public.profiles (created_at)
    WHERE embedded_at IS NULL;
