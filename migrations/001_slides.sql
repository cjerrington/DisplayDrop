CREATE TABLE IF NOT EXISTS slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE,
    display_order INTEGER,
    duration INTEGER DEFAULT 5,
    transition TEXT DEFAULT 'fade',
    active INTEGER DEFAULT 1
);
