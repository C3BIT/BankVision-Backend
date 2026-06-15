-- Add account_activation to changeType ENUM
-- Sequelize sync() does not ALTER existing ENUM columns, so this must be run manually on any
-- environment where the change_requests table was created before account_activation was added.
ALTER TABLE change_requests
  MODIFY COLUMN changeType ENUM('phone','email','address','account_activation') NOT NULL;

-- Add pdfUrls column for storing generated PDF form URLs (JSON array)
-- Safe to run even if column already exists (uses IF NOT EXISTS equivalent via SHOW COLUMNS guard)
ALTER TABLE change_requests
  ADD COLUMN IF NOT EXISTS pdfUrls TEXT NULL
    COMMENT 'JSON array of generated PDF form URLs attached to this record';
