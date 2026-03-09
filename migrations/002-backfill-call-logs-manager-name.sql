-- Backfill managerName in call_logs from managers table
-- Fixes existing records where managerName is NULL but managerEmail is present

UPDATE call_logs cl
JOIN managers m ON m.email = cl.managerEmail
SET cl.managerName = m.name
WHERE cl.managerName IS NULL
  AND cl.managerEmail IS NOT NULL;
