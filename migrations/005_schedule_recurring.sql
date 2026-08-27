ALTER TABLE slides ADD COLUMN schedule_repeat TEXT DEFAULT 'daily';
ALTER TABLE slides ADD COLUMN schedule_days TEXT;

-- Convert legacy "daily" schedules to the new recurring model (daily repeat).
UPDATE slides SET schedule_repeat = 'daily', schedule_type = 'recurring' WHERE schedule_type = 'daily';
