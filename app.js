import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import chokidar from 'chokidar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const db = new DatabaseSync('displaydrop.db');

// Configuration Section
const LIVE_MONITORING = process.env.LIVE_MONITORING || true;
const PORT = process.env.PORT || 3000;

// 1. Initialize DisplayDrop Database
db.exec(`
CREATE TABLE IF NOT EXISTS slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE,
    display_order INTEGER,
    duration INTEGER DEFAULT 5,
    transition TEXT DEFAULT 'fade',
    active INTEGER DEFAULT 1  -- 1 for enabled, 0 for disabled
)
`);

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());

const SLIDES_DIR = path.join(__dirname, 'public', 'slides');

// Ensure the slides directory exists so the app doesn't crash
if (!fs.existsSync(SLIDES_DIR)) {
    fs.mkdirSync(SLIDES_DIR, { recursive: true });
}

const upload = multer({
    dest: SLIDES_DIR,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
        if (allowed.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed (jpg, jpeg, png, gif, webp)'));
        }
    }
});

// 2. Sync Files to Database
function syncFiles() {
    const files = fs.readdirSync(SLIDES_DIR).filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
    const insert = db.prepare('INSERT OR IGNORE INTO slides (filename, display_order) VALUES (?, ?)');

    files.forEach((file, index) => {
        insert.run(file, index + 1);
    });
    console.log(`[DisplayDrop] Synced ${files.length} files from disk.`);
}

// 3. Optional Watcher (Toggle via Variable)
// If true, the app will monitor the slides directory for changes and update the database in real-time. 
// If false, it will only sync on startup and rely on manual refreshes or uploads through the dashboard. 
// This allows users to choose between a more dynamic experience or a more controlled one without constant monitoring.
if (LIVE_MONITORING) {
    chokidar.watch(SLIDES_DIR, { ignoreInitial: true }).on('add', (filePath) => {
        const filename = path.basename(filePath);
        const count = db.prepare('SELECT COUNT(*) as count FROM slides').get().count;
        db.prepare('INSERT OR IGNORE INTO slides (filename, display_order) VALUES (?, ?)').run(filename, count + 1);
        console.log(`[DisplayDrop] File Detected: ${filename}`);
    }).on('unlink', (filePath) => {
        const filename = path.basename(filePath);
        db.prepare('DELETE FROM slides WHERE filename = ?').run(filename);
        console.log(`[DisplayDrop] File Removed: ${filename}`);
    });
}

// 4. Routes
app.get('/', (req, res) => {
    const slides = db.prepare('SELECT * FROM slides ORDER BY display_order ASC').all();
    res.render('index', { slides });
});

app.get('/play', (req, res) => {
    res.render('display');
});

// API for the slideshow and dashboard
app.get('/api/slides', (req, res) => {
    const slides = db.prepare('SELECT * FROM slides WHERE active = 1 ORDER BY display_order ASC').all();
    res.json(slides);
});

app.post('/api/update-slides', (req, res) => {
    const { updates } = req.body;
    const updateStmt = db.prepare(`
    UPDATE slides
    SET display_order = ?, duration = ?, transition = ?, active = ?
    WHERE id = ?
    `);

    updates.forEach(u => updateStmt.run(u.display_order, u.duration, u.transition, u.active, u.id));
    res.json({ success: true });
});

app.post('/api/upload', upload.array('images', 50), (req, res) => {
    try {
        const uploaded = [];
        for (const file of req.files) {
            const ext = path.extname(file.originalname);
            const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
            const uniqueName = `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
            const destPath = path.join(SLIDES_DIR, uniqueName);
            fs.renameSync(file.path, destPath);
            const count = db.prepare('SELECT COUNT(*) as count FROM slides').get().count;
            db.prepare('INSERT OR IGNORE INTO slides (filename, display_order) VALUES (?, ?)').run(uniqueName, count + 1);
            uploaded.push(uniqueName);
        }
        res.json({ success: true, uploaded });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/slides/:id', (req, res) => {
    const { id } = req.params;
    const slide = db.prepare('SELECT filename FROM slides WHERE id = ?').get(id);
    if (!slide) return res.status(404).json({ success: false, error: 'Slide not found' });

    const filePath = path.join(SLIDES_DIR, slide.filename);
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        db.prepare('DELETE FROM slides WHERE id = ?').run(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    syncFiles();
    console.log(`
    ----------------------------------------
    DisplayDrop is live!
    Dashboard: http://localhost:${PORT}
    Play View: http://localhost:${PORT}/play
    ----------------------------------------
    `);
});
