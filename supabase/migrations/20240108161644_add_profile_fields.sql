-- Add new profile fields
ALTER TABLE profiles
ADD COLUMN maiden_name text,
ADD COLUMN address text,
ADD COLUMN birth_date text,
ADD COLUMN zip_code text,
ADD COLUMN geo_location text,
ADD COLUMN twitter_handles text[],
ADD COLUMN websites text[],
ADD COLUMN instant_messengers text[],
ADD COLUMN current_company text,
ADD COLUMN current_position text;

-- Ensure connections table only represents relationships
ALTER TABLE connections
DROP COLUMN IF EXISTS company,
DROP COLUMN IF EXISTS position,
DROP COLUMN IF EXISTS email,
DROP COLUMN IF EXISTS name;

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_profiles_current_company ON profiles(current_company);
CREATE INDEX IF NOT EXISTS idx_profiles_current_position ON profiles(current_position);

-- Add constraints to ensure data integrity
ALTER TABLE connections
ADD CONSTRAINT fk_user_profile
FOREIGN KEY (user_profile_id)
REFERENCES profiles(id)
ON DELETE CASCADE,
ADD CONSTRAINT fk_connection_profile
FOREIGN KEY (connection_profile_id)
REFERENCES profiles(id)
ON DELETE CASCADE;
