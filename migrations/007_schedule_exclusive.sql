-- Per-window "only this slide" flag. When a schedule row is marked exclusive
-- and its window is active, that slide plays alone instead of being mixed in
-- with the other scheduled (or normal) slides.
ALTER TABLE slide_schedules ADD COLUMN schedule_exclusive INTEGER NOT NULL DEFAULT 0;
