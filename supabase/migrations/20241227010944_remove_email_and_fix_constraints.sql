-- Remove email_address from connections and clean up foreign key constraints
BEGIN;

-- Drop duplicate foreign key constraints
ALTER TABLE connections
  DROP CONSTRAINT "fk_user_profile",
  DROP CONSTRAINT "fk_connection_profile";

-- Remove email_address column
ALTER TABLE connections
  DROP COLUMN email_address;

-- Ensure we have clean foreign key constraints with consistent naming
ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS "connections_user_profile_id_fkey",
  DROP CONSTRAINT IF EXISTS "connections_connection_profile_id_fkey",
  ADD CONSTRAINT connections_user_profile_id_fk FOREIGN KEY (user_profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT connections_connection_profile_id_fk FOREIGN KEY (connection_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- Add comment explaining table's purpose
COMMENT ON TABLE connections IS 'Represents relationships between LinkedIn profiles, no personal data stored here';

COMMIT;
