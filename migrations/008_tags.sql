-- Tagging: labels assigned to slides. An area playing a tag group (e.g.
-- /play?tags=lobby) shows slides carrying that tag plus all untagged slides.
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS slide_tags (
    slide_id INTEGER NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (slide_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_slide_tags_slide ON slide_tags(slide_id);
CREATE INDEX IF NOT EXISTS idx_slide_tags_tag ON slide_tags(tag_id);
