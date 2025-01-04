CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;

CREATE TABLE profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
    full_name TEXT,
    headline TEXT,
    linkedin_slug TEXT UNIQUE,
    is_shadow BOOLEAN DEFAULT false,
    summary TEXT,
    industry TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (user_id, full_name)
    VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data ->> 'full_name',
            NEW.raw_app_meta_data ->> 'full_name'
        )
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE PROCEDURE public.handle_new_user();

CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES profiles (id) ON DELETE CASCADE,
    company_id UUID REFERENCES companies (id),
    title TEXT,
    description TEXT,
    started_on DATE,
    finished_on DATE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE institutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE education (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES profiles (id) ON DELETE CASCADE,
    institution_id UUID REFERENCES institutions (id),
    degree_name TEXT,
    started_on DATE,
    finished_on DATE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES profiles (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id_a UUID REFERENCES profiles (id) ON DELETE CASCADE,
    profile_id_b UUID REFERENCES profiles (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (profile_id_a, profile_id_b),
    CHECK (profile_id_a < profile_id_b)
);

CREATE TABLE uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES profiles (id) NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE onboarding_state (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users (id) NOT NULL,
    current_step INTEGER NOT NULL DEFAULT 1,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('utc', now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('utc', now()),
    UNIQUE (user_id)
);

CREATE TRIGGER handle_updated_at
BEFORE UPDATE ON onboarding_state
FOR EACH ROW
EXECUTE PROCEDURE moddatetime(updated_at);

CREATE INDEX idx_connections_profile_a ON connections(profile_id_a);
CREATE INDEX idx_connections_profile_b ON connections(profile_id_b);
CREATE INDEX idx_connections_ordered_pairs ON connections(profile_id_a, profile_id_b);
CREATE INDEX idx_profiles_linkedin_slug ON profiles(linkedin_slug);
