-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE education ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_state ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "All profiles are viewable by everyone" 
    ON profiles FOR SELECT 
    TO PUBLIC
    USING (true);

CREATE POLICY "Users can update own profile" 
    ON profiles FOR UPDATE 
    USING (auth.uid() = id);

-- Companies policies
CREATE POLICY "Companies are viewable by everyone" 
    ON companies FOR SELECT 
    TO PUBLIC 
    USING (true);

CREATE POLICY "Authenticated users can create companies" 
    ON companies FOR INSERT 
    TO authenticated 
    WITH CHECK (true);

-- Positions policies
CREATE POLICY "Positions are viewable by everyone" 
    ON positions FOR SELECT 
    TO PUBLIC 
    USING (true);

CREATE POLICY "Users can manage their own positions" 
    ON positions FOR ALL 
    USING (auth.uid() = profile_id);

-- Institutions policies
CREATE POLICY "Institutions are viewable by everyone" 
    ON institutions FOR SELECT 
    TO PUBLIC 
    USING (true);

CREATE POLICY "Authenticated users can create institutions" 
    ON institutions FOR INSERT 
    TO authenticated 
    WITH CHECK (true);

-- Education policies
CREATE POLICY "Education entries are viewable by everyone" 
    ON education FOR SELECT 
    TO PUBLIC 
    USING (true);

CREATE POLICY "Users can manage their own education entries" 
    ON education FOR ALL 
    USING (auth.uid() = profile_id);

-- Skills policies
CREATE POLICY "Skills are viewable by everyone" 
    ON skills FOR SELECT 
    TO PUBLIC 
    USING (true);

CREATE POLICY "Users can manage their own skills" 
    ON skills FOR ALL 
    USING (auth.uid() = profile_id);

-- Connections policies
CREATE POLICY "Connections are viewable by connected users" 
    ON connections FOR SELECT 
    TO authenticated 
    USING (
        auth.uid() = profile_id_a OR 
        auth.uid() = profile_id_b
    );

CREATE POLICY "Users can create their own connections" 
    ON connections FOR INSERT 
    TO authenticated 
    WITH CHECK (auth.uid() = profile_id_a);

-- Uploads policies
CREATE POLICY "Users can view their own uploads" 
    ON uploads FOR SELECT 
    TO authenticated 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own uploads" 
    ON uploads FOR ALL 
    TO authenticated 
    USING (auth.uid() = user_id);

-- Onboarding state policies
CREATE POLICY "Users can view their own onboarding state" 
    ON onboarding_state FOR SELECT 
    TO authenticated 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own onboarding state" 
    ON onboarding_state FOR UPDATE 
    TO authenticated 
    USING (auth.uid() = user_id);

CREATE POLICY "System can create onboarding state" 
    ON onboarding_state FOR INSERT 
    TO authenticated 
    WITH CHECK (auth.uid() = user_id);

-- Grant necessary permissions to authenticated and anon roles
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

CREATE POLICY "Allow authenticated users to upload files"
ON storage.objects FOR INSERT 
TO authenticated
WITH CHECK (
    bucket_id = 'linkedin' AND 
    auth.role() = 'authenticated'
);

CREATE POLICY "Allow public to view linkedin files"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'linkedin');

-- Give access to authenticated users to use the linkedin bucket
GRANT ALL ON storage.objects TO authenticated;
