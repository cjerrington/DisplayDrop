import 'dotenv/config';
import express from 'express';
import ejs from 'ejs';
import { DatabaseSync } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import multer from 'multer';
import chokidar from 'chokidar';
import session from 'express-session';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In a Bun-compiled executable, import.meta.url points into the embedded
// virtual filesystem (/$bunfs/...); the real location is the executable.
// Resolve the app's folder either way, then make all relative paths
// (views/, public/, displaydrop.db) work regardless of the launch directory.
let appDir = __dirname;
if (appDir.includes('/$bunfs/')) appDir = path.dirname(process.execPath);
process.chdir(appDir);
const app = express();
const db = new DatabaseSync('displaydrop.db');

// Configuration Section
const LIVE_MONITORING = process.env.LIVE_MONITORING || true;
const PORT = process.env.PORT || 3000;
const VALID_ROLES = ['admin', 'contributor'];

// 1. Database Migrations
// Every startup applies any pending migrations in /migrations so existing
// databases are upgraded in place. Add new files as numbered SQL scripts.
const MIGRATIONS_DIR = path.join(appDir, 'migrations');

function runMigrations() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);

    const applied = new Set(
        db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name)
    );
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        db.exec('BEGIN');
        try {
            db.exec(sql);
            db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
            db.exec('COMMIT');
            console.log(`[DisplayDrop] Applied migration: ${file}`);
        } catch (err) {
            db.exec('ROLLBACK');
            throw new Error(`Migration failed (${file}): ${err.message}`);
        }
    }
}

runMigrations();

// 2. Session Secret
// Prefer an env var, otherwise persist a generated secret in the DB so
// sessions survive restarts.
function getSessionSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    const row = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
    if (row) return row.value;
    const secret = randomBytes(32).toString('hex');
    db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(secret);
    console.log('[DisplayDrop] Generated a persistent session secret.');
    return secret;
}

const SESSION_SECRET = getSessionSecret();

// 3. Password Helpers (node:crypto scrypt — no native deps)
function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    try {
        const [salt, hash] = stored.split(':');
        const expected = Buffer.from(hash, 'hex');
        const actual = scryptSync(password, salt, 64);
        return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

// Password reset tokens (one-time, time-limited, stored hashed)
const RESET_TOKEN_TTL = 60 * 60 * 1000; // 1 hour

function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

function generateResetToken(userId) {
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
        .run(userId, hashToken(token), Date.now() + RESET_TOKEN_TTL);
    return token;
}

function findValidReset(token) {
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0')
        .get(hashToken(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    return row;
}

// Remove all active sessions belonging to a user (except the current one)
function destroyUserSessions(userId, exceptSid = null) {
    const rows = db.prepare('SELECT sid, data FROM sessions').all();
    for (const row of rows) {
        if (row.sid === exceptSid) continue;
        try {
            const data = JSON.parse(row.data);
            if (data && data.user && data.user.id === userId) {
                db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
            }
        } catch { /* skip malformed rows */ }
    }
}

// 4b. Slide Scheduling
// A slide can have MULTIPLE schedules (e.g. one window per passing period).
// While any of a slide's windows is active, it takes over the display and
// its duration stretches to fill the whole window (start->end).
//
// Schedule entry shapes (as sent by the dashboard):
//   { type: 'recurring', repeat: 'daily',            start: 'HH:MM', end: 'HH:MM' }
//   { type: 'recurring', repeat: 'weekly', start/end, days: [1..7] } // 1=Mon..7=Sun
//   { type: 'once',      start: 'YYYY-MM-DDTHH:MM', end: 'YYYY-MM-DDTHH:MM' }
const SCHEDULE_TYPES = ['recurring', 'once'];
const TIME_RE = /^\d{2}:\d{2}$/;
const ONCE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// Validates one schedule entry. Returns a normalized row-shaped object
// ({ schedule_type, schedule_repeat, schedule_days, schedule_start,
// schedule_end, schedule_exclusive }) or null when the entry is invalid/empty.
function sanitizeScheduleEntry(entry) {
    const type = SCHEDULE_TYPES.includes(entry && entry.type) ? entry.type : null;
    if (!type) return null;
    const start = (entry.start || '').trim();
    const end = (entry.end || '').trim();
    const exclusive = entry.exclusive ? 1 : 0;

    if (type === 'recurring') {
        if (!TIME_RE.test(start) || !TIME_RE.test(end) || start === end) return null;
        const repeat = entry.repeat === 'weekly' ? 'weekly' : 'daily';
        let days = null;
        if (repeat === 'weekly') {
            const raw = Array.isArray(entry.days)
                ? entry.days
                : String(entry.days || '').split(',').filter(Boolean).map(Number);
            const iso = raw.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7);
            const unique = [...new Set(iso)].sort();
            if (unique.length === 0) return null;
            days = unique.join(',');
        }
        return { schedule_type: 'recurring', schedule_repeat: repeat, schedule_days: days, schedule_start: start, schedule_end: end, schedule_exclusive: exclusive };
    }

    // 'once'
    if (!ONCE_RE.test(start) || !ONCE_RE.test(end) || start >= end) return null;
    return { schedule_type: 'once', schedule_repeat: null, schedule_days: null, schedule_start: start, schedule_end: end, schedule_exclusive: exclusive };
}

// "HH:MM" and "YYYY-MM-DDTHH:MM" strings (server local time) compare lexically.
function nowTimeString() {
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(now.getFullYear())}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
}

// ISO weekday (1=Mon..7=Sun) for a Date.
function isoWeekday(date) {
    return date.getDay() === 0 ? 7 : date.getDay();
}

// HH:MM window check; start > end means the window wraps past midnight.
function timeInWindow(now, st, en) {
    if (st <= en) return now >= st && now <= en;
    return now >= st || now <= en;
}

// Is a single schedule row active right now?
function scheduleIsActive(entry) {
    if (!entry || !entry.schedule_type) return false;

    if (entry.schedule_type === 'recurring' && entry.schedule_start && entry.schedule_end) {
        const now = nowTimeString().slice(11);
        if (entry.schedule_repeat === 'weekly') {
            const days = (entry.schedule_days || '').split(',').map(Number);
            if (!days.includes(isoWeekday(new Date()))) return false;
        }
        return timeInWindow(now, entry.schedule_start, entry.schedule_end);
    }

    if (entry.schedule_type === 'once' && entry.schedule_start && entry.schedule_end) {
        const now = nowTimeString();
        return now >= entry.schedule_start && now <= entry.schedule_end;
    }
    return false;
}

// Length of a schedule window in seconds (start -> end, wrap-aware).
function windowDurationSeconds(entry) {
    if (entry.schedule_type === 'once') {
        const s = new Date(entry.schedule_start).getTime();
        const e = new Date(entry.schedule_end).getTime();
        if (isNaN(s) || isNaN(e) || e <= s) return 0;
        return Math.round((e - s) / 1000);
    }
    const [sh, sm] = (entry.schedule_start || '').split(':').map(Number);
    const [eh, em] = (entry.schedule_end || '').split(':').map(Number);
    if (isNaN(sh) || isNaN(eh)) return 0;
    const durMin = (eh * 60 + em - (sh * 60 + sm) + 1440) % 1440;
    return durMin === 0 ? 1440 * 60 : durMin * 60; // full-day window when start===end
}

// All schedule rows for a slide, in display order.
const slideSchedulesStmt = db.prepare('SELECT * FROM slide_schedules WHERE slide_id = ? ORDER BY display_order ASC, id ASC');

function slideSchedules(slideId) {
    return slideSchedulesStmt.all(slideId);
}

// 4a. Tagging
// Tags are labels on slides. An area playing a tag group (/play?tags=lobby)
// shows slides carrying that tag plus every untagged ("general") slide.
const allTagsStmt = db.prepare('SELECT id, name FROM tags ORDER BY LOWER(name) ASC');
const slideTagIdsStmt = db.prepare('SELECT tag_id FROM slide_tags WHERE slide_id = ?');
const tagIdsStmt = db.prepare('SELECT id FROM tags WHERE name = ?');
const insertTagStmt = db.prepare('INSERT INTO tags (name) VALUES (?)');
const insertSlideTagStmt = db.prepare('INSERT OR IGNORE INTO slide_tags (slide_id, tag_id) VALUES (?, ?)');
const deleteSlideTagsStmt = db.prepare('DELETE FROM slide_tags WHERE slide_id = ?');

function allTags() {
    return allTagsStmt.all();
}

function tagsForSlide(slideId) {
    return slideTagIdsStmt.all(slideId).map(r => r.tag_id);
}

function tagName(tagId) {
    return db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId);
}

// Get the tag id for a name, creating the tag if it doesn't exist yet.
function tagIdForName(name) {
    const cleaned = (name || '').trim();
    if (!cleaned) return null;
    const existing = tagIdsStmt.get(cleaned);
    if (existing) return existing.id;
    const info = insertTagStmt.run(cleaned);
    return Number(info.lastInsertRowid);
}

// Rewrite a slide's tag set from tag ids (as sent by the dashboard).
// Ids that no longer exist are skipped, so stale selections never resurrect
// a tag that was renamed or deleted from the Settings tag editor.
function saveSlideTagIds(slideId, ids) {
    deleteSlideTagsStmt.run(slideId);
    const seen = new Set();
    (ids || []).forEach(rawId => {
        const id = Number(rawId);
        if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return;
        if (!db.prepare('SELECT id FROM tags WHERE id = ?').get(id)) return;
        seen.add(id);
        insertSlideTagStmt.run(slideId, id);
    });
}

// Does a slide belong on an area that asked for the given tags?
// Untagged slides are "general" and play on every area.
function slideMatchesArea(slide, requestedTags) {
    if (!requestedTags || requestedTags.length === 0) return true;
    const slideTags = slide.tag_ids || [];
    if (slideTags.length === 0) return true;
    return slideTags.some(tid => requestedTags.includes(tid));
}

// 4. First-Run Setup
// No accounts exist on a fresh install. Every request is forced to the
// /setup wizard, which creates the initial admin account. No default
// credentials are ever generated, so nothing can be pre-taken.
function needsSetup() {
    return db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;
}

app.engine('ejs', ejs.renderFile);
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 5. Sessions (stored in SQLite)
function getSessionExpiry(sess) {
    const raw = sess.cookie && sess.cookie.expires;
    if (raw && raw !== 'Session') {
        const t = new Date(raw).getTime();
        if (!isNaN(t)) return t;
    }
    return Date.now() + 7 * 24 * 60 * 60 * 1000;
}

class SQLiteSessionStore extends session.Store {
    constructor(database) {
        super();
        this.db = database;
    }

    get(sid, cb) {
        const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
        if (!row) return cb(null, null);
        if (row.expires && row.expires < Date.now()) {
            this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
            return cb(null, null);
        }
        try {
            cb(null, JSON.parse(row.data));
        } catch (err) {
            cb(err);
        }
    }

    set(sid, sess, cb) {
        this.db.prepare(`
            INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
        `).run(sid, JSON.stringify(sess), getSessionExpiry(sess));
        if (cb) cb(null);
    }

    destroy(sid, cb) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        if (cb) cb(null);
    }

    touch(sid, sess, cb) {
        this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?')
            .run(getSessionExpiry(sess), sid);
        if (cb) cb(null);
    }
}

app.use(session({
    store: new SQLiteSessionStore(db),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// 5b. First-run setup gate: while no users exist, everything is redirected
// to /setup. The player and slides API stay reachable so displays keep running.
app.use((req, res, next) => {
    if (needsSetup()) {
        const exempt = ['/setup', '/play', '/api/slides'];
        if (!exempt.includes(req.path)) {
            return res.redirect('/setup');
        }
    }
    next();
});

// 6. Auth Middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/login');
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (req.session && req.session.user && roles.includes(req.session.user.role)) return next();
        return res.status(403).send('Forbidden');
    };
}

const SLIDES_DIR = path.join(appDir, 'public', 'slides');

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

// 7. Sync Files to Database
function syncFiles() {
    const files = fs.readdirSync(SLIDES_DIR).filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
    const insert = db.prepare('INSERT OR IGNORE INTO slides (filename, display_order) VALUES (?, ?)');

    files.forEach((file, index) => {
        insert.run(file, index + 1);
    });
    console.log(`[DisplayDrop] Synced ${files.length} files from disk.`);
}

// 8. Optional Watcher (Toggle via Variable)
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
        const slide = db.prepare('SELECT id FROM slides WHERE filename = ?').get(filename);
        if (slide) {
            db.prepare('DELETE FROM slide_schedules WHERE slide_id = ?').run(slide.id);
            db.prepare('DELETE FROM slides WHERE filename = ?').run(filename);
        }
        console.log(`[DisplayDrop] File Removed: ${filename}`);
    });
}

// 9. First-Run Setup Routes
app.get('/setup', (req, res) => {
    if (!needsSetup()) return res.redirect('/login');
    if (req.session.user) return res.redirect('/');
    res.render('setup', { error: null });
});

app.post('/setup', (req, res) => {
    if (!needsSetup()) return res.redirect('/login');

    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const passwordConfirm = req.body.password_confirm || '';

    if (!username) return res.status(400).render('setup', { error: 'Username is required.' });
    if (password.length < 8) return res.status(400).render('setup', { error: 'Password must be at least 8 characters.' });
    if (password !== passwordConfirm) return res.status(400).render('setup', { error: 'Passwords do not match.' });

    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(username, hashPassword(password), 'admin');
    console.log(`[DisplayDrop] Initial admin account created: "${username}"`);

    req.session.regenerate((err) => {
        if (err) return res.status(500).render('setup', { error: 'Could not start a session.' });
        const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
        req.session.user = { id: user.id, username: user.username, role: user.role };
        res.redirect('/');
    });
});

// 10. Auth Routes
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { error: null, reset: !!req.query.reset });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).render('login', { error: 'Invalid username or password.', reset: false });
    }
    req.session.regenerate((err) => {
        if (err) return res.status(500).render('login', { error: 'Could not start a session.', reset: false });
        req.session.user = { id: user.id, username: user.username, role: user.role };
        res.redirect('/');
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// 11. User Management (Admin Only)
const USER_ERRORS = {
    'bad-input': 'Username is required and password must be at least 8 characters.',
    exists: 'A user with that username already exists.',
    notfound: 'User not found.',
    'no-self': "You can't modify your own account."
};
const USER_MESSAGES = {
    created: 'User created.',
    updated: 'User role updated.',
    deleted: 'User deleted.'
};

const PW_ERRORS = {
    'wrong-current': 'Current password is incorrect.',
    short: 'New password must be at least 8 characters.',
    mismatch: 'New passwords do not match.'
};

// Settings — each section is its own view sharing the sidebar nav.
const SETTINGS_SECTIONS = ['account', 'users', 'tags', 'links'];

app.get('/settings', requireAuth, (req, res) => {
    res.redirect('/settings/account');
});

app.get('/settings/:section', requireAuth, (req, res) => {
    if (!SETTINGS_SECTIONS.includes(req.params.section)) {
        return res.redirect('/settings/account');
    }
    const section = req.params.section;
    if (section === 'users' && req.session.user.role !== 'admin') {
        return res.redirect('/settings/account');
    }
    const isAdmin = req.session.user.role === 'admin';
    res.render('settings', {
        section,
        users: isAdmin
            ? db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC').all()
            : [],
        tags: allTags(),
        error: USER_ERRORS[req.query.error],
        message: USER_MESSAGES[req.query.msg],
        pwError: PW_ERRORS[req.query.pwerr],
        pwMsg: req.query.pwmsg === 'changed'
    });
});

app.get('/users', requireAuth, requireRole('admin'), (req, res) => {
    res.redirect('/settings/users');
});

app.post('/users', requireAuth, requireRole('admin'), (req, res) => {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'contributor';
    if (!username || password.length < 8) {
        return res.redirect('/settings/users?error=bad-input');
    }
    try {
        db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
            .run(username, hashPassword(password), role);
        res.redirect('/settings/users?msg=created');
    } catch {
        res.redirect('/settings/users?error=exists');
    }
});

app.post('/users/:id/role', requireAuth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!target) return res.redirect('/settings/users?error=notfound');
    if (target.id === req.session.user.id) return res.redirect('/settings/users?error=no-self');
    const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'contributor';
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    res.redirect('/settings/users?msg=updated');
});

app.post('/users/:id/delete', requireAuth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.user.id) return res.redirect('/settings/users?error=no-self');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.redirect('/settings/users?msg=deleted');
});

// 12. Password Reset (Admin-Assisted)
// Admin generates a one-time, time-limited reset link for a user and shares
// it out-of-band. The user opens it to set a new password while logged out.
app.get('/users/:id/reset', requireAuth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    if (!target) return res.redirect('/settings/users?error=notfound');
    res.render('user-reset', { target, link: null, error: null });
});

app.post('/users/:id/reset', requireAuth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    if (!target) return res.redirect('/settings/users?error=notfound');

    const token = generateResetToken(id);
    const link = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;
    console.log(`[DisplayDrop] Reset link generated for "${target.username}" by ${req.session.user.username}`);
    res.render('user-reset', { target, link, error: null });
});

// Public page: user enters (or is given) a reset token and sets a new password
app.get('/reset-password', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('reset-password', {
        token: req.query.token || '',
        error: null,
        success: false
    });
});

app.post('/reset-password', (req, res) => {
    const token = (req.body.token || '').trim();
    const password = req.body.password || '';
    const passwordConfirm = req.body.password_confirm || '';

    if (password.length < 8) {
        return res.status(400).render('reset-password', { token, error: 'Password must be at least 8 characters.', success: false });
    }
    if (password !== passwordConfirm) {
        return res.status(400).render('reset-password', { token, error: 'Passwords do not match.', success: false });
    }

    const reset = findValidReset(token);
    if (!reset) {
        return res.status(400).render('reset-password', { token: '', error: 'This reset link is invalid or has expired. Ask an admin for a new one.', success: false });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(reset.user_id);
    if (!user) {
        return res.status(400).render('reset-password', { token: '', error: 'This account no longer exists.', success: false });
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(reset.id);
    destroyUserSessions(user.id);

    res.render('reset-password', { token: '', error: null, success: true });
});

// Logged-in users change their own password (requires current password)
app.get('/change-password', requireAuth, (req, res) => {
    res.redirect('/settings/account');
});

app.post('/change-password', requireAuth, (req, res) => {
    const { current_password, password, password_confirm } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!user || !verifyPassword(current_password, user.password_hash)) {
        return res.redirect('/settings/account?pwerr=wrong-current');
    }
    if (password.length < 8) {
        return res.redirect('/settings/account?pwerr=short');
    }
    if (password !== password_confirm) {
        return res.redirect('/settings/account?pwerr=mismatch');
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    destroyUserSessions(user.id, req.session.id);
    res.redirect('/settings/account?pwmsg=changed');
});

// 13. App Routes
app.get('/', requireAuth, (req, res) => {
    const slides = db.prepare('SELECT * FROM slides ORDER BY display_order ASC').all().map(slide => {
        const tagIds = tagsForSlide(slide.id);
        return {
            ...slide,
            schedules: slideSchedules(slide.id),
            tag_ids: tagIds,
            tags: tagIds.map(id => tagName(id).name)
        };
    });
    res.render('index', { slides, tags: allTags() });
});

app.get('/play', (req, res) => {
    res.render('display', { tags: allTags() });
});

// API for the slideshow and dashboard
app.get('/api/slides', (req, res) => {
    const requestedTags = String(req.query.tags || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    // When the area asks for tag groups, resolve them to ids and keep only the
    // slides that match a requested tag or are untagged ("general").
    let wantedIds = null;
    if (requestedTags.length > 0) {
        const requested = requestedTags
            .map(t => tagIdsStmt.get(t))
            .filter(Boolean)
            .map(r => r.id);
        wantedIds = requested.length > 0 ? requested : [-1];
    }

    const slides = db
        .prepare('SELECT * FROM slides WHERE active = 1 ORDER BY display_order ASC')
        .all()
        .map(slide => {
            const tagIds = tagsForSlide(slide.id);
            return {
                ...slide,
                tag_ids: tagIds,
                tags: tagIds.map(id => tagName(id).name)
            };
        })
        .filter(slide => slideMatchesArea(slide, wantedIds));

    const present = ({ tag_ids, ...rest }) => rest;

    const withSchedules = slides.map(slide => ({ slide, scheds: slideSchedules(slide.id) }));
    const scheduled = withSchedules.filter(({ scheds }) => scheds.some(scheduleIsActive));
    if (scheduled.length === 0) return res.json(slides.map(present));

    // If any active window is marked "exclusive", only those slides play —
    // they take over the display alone instead of mixing with other slides.
    const exclusive = scheduled.filter(({ scheds }) => scheds.some(s => scheduleIsActive(s) && s.schedule_exclusive));
    const chosen = exclusive.length > 0 ? exclusive : scheduled;

    // A scheduled slide shows for its whole window, not its playlist duration.
    res.json(chosen.map(({ slide, scheds }) => {
        const active = scheds.filter(scheduleIsActive);
        const stretch = Math.max(...active.map(windowDurationSeconds), 0);
        return present({ ...slide, duration: stretch > 0 ? stretch : slide.duration });
    }));
});

app.post('/api/update-slides', requireAuth, requireRole('admin', 'contributor'), (req, res) => {
    const { updates } = req.body;
    const updateStmt = db.prepare(`
    UPDATE slides
    SET display_order = ?, duration = ?, transition = ?, active = ?
    WHERE id = ?
    `);
    const deleteSchedules = db.prepare('DELETE FROM slide_schedules WHERE slide_id = ?');
    const insertSchedule = db.prepare(`
    INSERT INTO slide_schedules (slide_id, schedule_type, schedule_repeat, schedule_days, schedule_start, schedule_end, schedule_exclusive, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    updates.forEach(u => {
        updateStmt.run(u.display_order, u.duration, u.transition, u.active, u.id);
        deleteSchedules.run(u.id);

        // Accept both the new multi-schedule format and the legacy single one.
        const entries = Array.isArray(u.schedules)
            ? u.schedules
            : (u.schedule ? [u.schedule] : []);
        entries.forEach((entry, index) => {
            const s = sanitizeScheduleEntry(entry);
            if (!s) return;
            insertSchedule.run(u.id, s.schedule_type, s.schedule_repeat, s.schedule_days, s.schedule_start, s.schedule_end, s.schedule_exclusive, index);
        });

        if (Array.isArray(u.tags)) saveSlideTagIds(u.id, u.tags);
    });
    res.json({ success: true });
});

// Tag management (dashboard). Names are trimmed; the unique constraint keeps
// the list clean. Deleting a tag removes it from every slide.
app.get('/api/tags', requireAuth, requireRole('admin', 'contributor'), (req, res) => {
    res.json(allTags().map(tag => ({
        ...tag,
        count: db.prepare('SELECT COUNT(*) AS c FROM slide_tags WHERE tag_id = ?').get(tag.id).c
    })));
});

app.post('/api/tags', requireAuth, requireRole('admin', 'contributor'), (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Tag name is required.' });
    if (name.length > 50) return res.status(400).json({ success: false, error: 'Tag names are limited to 50 characters.' });
    try {
        const id = tagIdForName(name);
        return res.json({ success: true, tag: { id, name } });
    } catch {
        return res.status(400).json({ success: false, error: 'A tag with that name already exists.' });
    }
});

app.put('/api/tags/:id', requireAuth, requireRole('admin', 'contributor'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Tag name is required.' });
    const existing = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false, error: 'Tag not found.' });
    if (db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(name, id)) {
        return res.status(400).json({ success: false, error: 'A tag with that name already exists.' });
    }
    db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
    res.json({ success: true, tag: { id, name } });
});

app.delete('/api/tags/:id', requireAuth, requireRole('admin', 'contributor'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM slide_tags WHERE tag_id = ?').run(id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    res.json({ success: true });
});

app.post('/api/upload', requireAuth, requireRole('admin', 'contributor'), upload.array('images', 50), (req, res) => {
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

app.delete('/api/slides/:id', requireAuth, requireRole('admin', 'contributor'), (req, res) => {
    const { id } = req.params;
    const slide = db.prepare('SELECT filename FROM slides WHERE id = ?').get(id);
    if (!slide) return res.status(404).json({ success: false, error: 'Slide not found' });

    const filePath = path.join(SLIDES_DIR, slide.filename);
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        db.prepare('DELETE FROM slide_schedules WHERE slide_id = ?').run(id);
        db.prepare('DELETE FROM slides WHERE id = ?').run(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Clean up expired sessions and reset tokens on startup
db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(Date.now());

app.listen(PORT, () => {
    syncFiles();
    if (needsSetup()) {
        console.log(`
    ----------------------------------------
    DisplayDrop is live!
    First run: create your admin account at http://localhost:${PORT}/setup
    Play View: http://localhost:${PORT}/play
    ----------------------------------------
    `);
        return;
    }
    console.log(`
    ----------------------------------------
    DisplayDrop is live!
    Dashboard: http://localhost:${PORT}
    Play View: http://localhost:${PORT}/play
    ----------------------------------------
    `);
});
