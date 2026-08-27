-- Multiple schedules per slide (e.g. several passing-period windows on one slide).
CREATE TABLE IF NOT EXISTS slide_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slide_id INTEGER NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    schedule_type TEXT NOT NULL DEFAULT 'recurring',
    schedule_repeat TEXT DEFAULT 'daily',
    schedule_days TEXT,
    schedule_start TEXT NOT NULL,
    schedule_end TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_slide_schedules_slide ON slide_schedules(slide_id);

-- Carry over any existing single schedules from the old slides columns.
INSERT INTO slide_schedules (slide_id, schedule_type, schedule_repeat, schedule_days, schedule_start, schedule_end, display_order)
SELECT id,
       CASE WHEN schedule_type IS NULL OR schedule_type = 'none' THEN 'recurring' ELSE schedule_type END,
       COALESCE(schedule_repeat, 'daily'),
       schedule_days,
       schedule_start,
       schedule_end,
       0
FROM slides
WHERE schedule_type IS NOT NULL
  AND schedule_type != 'none'
  AND schedule_start IS NOT NULL
  AND schedule_end IS NOT NULL;
