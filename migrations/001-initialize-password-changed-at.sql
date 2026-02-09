-- Initialize passwordChangedAt for existing managers
-- This ensures existing accounts aren't immediately expired when password expiry feature is deployed

UPDATE managers 
SET passwordChangedAt = NOW() 
WHERE passwordChangedAt IS NULL;
