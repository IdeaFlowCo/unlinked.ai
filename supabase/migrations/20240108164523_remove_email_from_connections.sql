-- Add comment explaining the table's purpose
COMMENT ON TABLE connections IS 'Represents relationships between LinkedIn profiles, no personal data stored here';

-- Verify no personal data columns exist
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'connections'
        AND column_name = 'email'
    ) THEN
        ALTER TABLE connections DROP COLUMN email;
    END IF;
END $$;
