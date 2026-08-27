ALTER TABLE slides ADD COLUMN schedule_type TEXT DEFAULT 'none';
ALTER TABLE slides ADD COLUMN schedule_start TEXT;
ALTER TABLE slides ADD COLUMN schedule_end TEXT;
