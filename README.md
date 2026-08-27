# DisplayDrop

A lightweight, self-contained digital signage application for image slideshows. Built with Express, SQLite, and vanilla JS.

## Features

- **User Accounts & Login** — Sessions stored in SQLite; unauthenticated visitors are redirected to `/login`
- **Role-Based Access** — `admin` and `contributor` roles (see [Authentication](#authentication))
- **Settings Page** — Separate views for changing your password, user management (admins), the tag editor, and player links, all sharing one sidebar navigation
- **Dashboard Control Panel** — Manage slides, set duration, transitions, and toggle visibility
- **Drag & Drop Upload** — Upload multiple images (JPG, PNG, GIF, WEBP) via drag-and-drop or file browser
- **Live File Sync** — Automatically detects images added or removed from the `public/slides/` folder (configurable)
- **Slide Player** — Dedicated `/play` view with fullscreen support (double-click or press `F`)
- **Multiple Transitions** — Choose from Fade, Slide Left, Slide Right, Push, or Cut transitions
- **Drag-to-Reorder** — Sortable table rows for quick playlist arrangement
- **Bulk Actions** — Apply duration and transition settings to all slides at once
- **Delete Slides** — Remove slides directly from the dashboard (deletes both DB entry and file)
- **Smart Updates** — Display view intelligently syncs changes without interrupting playback
- **Per-Slide Scheduling** — Set a daily recurring window or a one-time date/time per slide; scheduled slides take over the display while active (see [Scheduling](#scheduling))
- **Tags & Per-Area Playlists** — Tag slides and point each display at its own group URL; each area plays its tagged slides plus the untagged ("general") ones (see [Tags & Areas](#tags--areas))
- **Built-in Database Migrations** — Pending SQL scripts in `migrations/` apply automatically on startup
- **Zero External DB Server** — SQLite via a `node:sqlite`-compatible layer that uses Node's built-in `node:sqlite` when run with Node and `bun:sqlite` when compiled into the standalone binary; data lives in a local `displaydrop.db` file

## Getting Started

```bash
npm install
npm start
```

Open your browser to:

- Dashboard: http://localhost:3000
- Play View: http://localhost:3000/play

During development, use `npm run dev` for auto-restart on file changes.

## Standalone Binary (no Node required)

Build a self-contained executable with [Bun](https://bun.sh) — the target machine only needs the built folder, not Node:

```bash
# On the build machine (Bun >= 1.3, same OS/arch as the target)
npm run build
# or: bash scripts/build.sh
```

This produces `build/` containing the `displaydrop` executable plus its runtime assets (`views/`, `migrations/`, `public/css/`). `displaydrop.db` is **not** included — the app creates it on first run.

Deploy by copying the whole `build/` folder to the target machine, then run it from anywhere:

```bash
./displaydrop
```

The binary is self-locating: it uses the folder it lives in for the database, templates, and static files, so the launch directory doesn't matter. First run creates `displaydrop.db`, applies migrations, and creates `public/slides/`; place slide images there (or upload them from the dashboard). Set `PORT` (or a `.env` file next to the binary) to change the port.

> Binaries are not cross-platform: build on the same OS/arch as the target (Linux x64 here). Other platforms can be added later.

## Authentication

On first run there are **no accounts** and no default credentials. Visiting the app redirects you to `/setup`, where you create the initial admin account. After that, `/setup` is permanently locked and all visitors go to `/login`.

### Roles

| Role | Permissions |
|------|-------------|
| `admin` | Everything: manage users, upload/manage/delete slides, all settings |
| `contributor` | Upload images, manage slides (reorder, duration, transitions, active state, delete) |

Admins can create, delete, or change the role of other users at **Settings → User Management** (`/settings/users`). Admins cannot delete or demote their own account. The old `/users` and `/change-password` pages redirect to the settings section pages.

### Password resets

- **Logged in**: Any user can change their own password at **Settings → Account** (`/settings/account`, verifies the current password first).
- **Logged out**: An admin generates a one-time reset link for a user from **Settings → User Management → Reset**. The link (expires in 1 hour, single-use) is shared out-of-band and opens the `/reset-password` page. Resetting revokes all of the user's active sessions.

### Security notes

- Passwords are hashed with Node's built-in `crypto.scrypt`.
- Set `SESSION_SECRET` to a long random string so sessions remain valid across restarts. If unset, a random secret is generated and stored in the database.
- `GET /play` and `GET /api/slides` are intentionally public — signage displays don't log in.
- During first-run setup, all routes are blocked except the setup page, player, and slides API.

## Configuration

- **Port**: Set `PORT` env variable (default: `3000`)
- **Live Monitoring**: Set `LIVE_MONITORING` env variable to `true` or `false` (default: `true`) — when enabled, automatically watches the slides directory for changes
- **Session Secret**: Set `SESSION_SECRET` (default: generated and persisted in the DB)
- **Slides Directory**: `public/slides/` — drop images here or use the dashboard uploader
- **Database**: `displaydrop.db` — auto-created on first run

See `.env.example` for all available environment variables.

## Scheduling

Each slide can be given **one or more schedule windows** (Dashboard → the **Schedule** button on a slide row). The editor shows a weekly grid (Mon–Sun) with your windows drawn on it, plus an editable list — handy for things like school passing periods, where one slide needs several windows a day.

Each window can be:

- **Recurring — Daily** — e.g. `09:05–09:10` shows the slide for 5 minutes every day. Setting end before start (e.g. `23:50–00:10`) creates an overnight window.
- **Recurring — Weekly** — same time window but only on the selected days of the week (Mon–Sun pickers).
- **One-time** — a specific start and end date/time for a single event.

Ticking **"Only show this slide during this window"** (shown as `solo` on the schedule button) makes that window **exclusive**: while it's active, only this slide plays — it isn't mixed in with the other scheduled slides or the normal playlist. Leave it unticked to let the slide join the usual mini-playlist of whatever's scheduled.

While any of a slide's windows is active, **only scheduled slides play** (they take over the display) and the slide **stays on screen for the whole window** — its `Duration` column is ignored during a scheduled window, so a `09:05–09:10` window shows for the full 5 minutes. Normal playback resumes when all windows end. If several schedules overlap across slides, all the overlapping slides play together as a mini-playlist (unless one of them is marked `solo`); the dashboard warns about overlaps before saving.

- Schedule times are evaluated in the **server's local timezone** (weekday selection follows the server's clock too).
- The player re-polls the slides API every 5 seconds, so a scheduled window starts/stops within a few seconds. When a window ends mid-slide, the player moves on to the next slide immediately instead of waiting out the old duration.
- Scheduled slides respect the **Live** toggle: a slide disabled in the table never takes over.

## Tags & Areas

Tag slides so different displays (lobby TV, cafeteria screen, hallway monitor…) can each play their own set of images while still sharing the untagged defaults.

- **Assign tags** via the **Tags** button on a slide row — check any number of tags; slides with no tags are **general** and play on every area.
- **Create, rename, delete tags** in **Settings → Tags** (`/settings/tags`) — renaming/deleting updates every slide that uses the tag.
- **One URL per area**: `/play` plays all active slides; `/play?tags=lobby` plays slides tagged `lobby` **plus** all general (untagged) slides. **Settings → Player Links** (`/settings/links`) lists every area URL with **Open** and **Copy link** buttons; the dashboard's **Player Links** card and the **Launch Player** menu in the header also launch them. Hovering the player shows a small bar to switch groups live.
- A slide with several tags appears on every area that includes any of them (e.g. a slide tagged `lobby` and `cafeteria` shows on both).
- **Schedules follow the same filter**: a scheduled slide only takes over the areas that include its tags; an untagged scheduled slide takes over everywhere. The exclusive (`solo`) window option still applies within that area.

## Database Migrations

Database schema is managed by numbered SQL files in the `migrations/` folder. On every startup, DisplayDrop applies any migrations not yet recorded in the `schema_migrations` table, so existing databases upgrade in place as you pull updates.

To add a schema change:

1. Create `migrations/00N_description.sql` (higher number than the latest)
2. Add your `CREATE TABLE` / `ALTER TABLE` statements
3. Restart the app — it applies automatically

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | Required | Dashboard |
| `GET` | `/settings` | Required | Redirects to `/settings/account` |
| `GET` | `/settings/account` | Required | Change own password (account settings) |
| `GET` | `/settings/users` | admin | User management (users section) |
| `GET` | `/settings/tags` | Required | Tag editor (tags section) |
| `GET` | `/settings/links` | Required | Player Links (area URLs) |
| `GET` | `/setup` | First run only | Create the initial admin account |
| `GET` | `/login` | Public | Login page |
| `POST` | `/login` | Public | Authenticate (`username`, `password`) |
| `POST` | `/logout` | Required | End the session |
| `GET` | `/users` | admin | Redirects to `/settings/users` |
| `POST` | `/users` | admin | Create a user (`username`, `password`, `role`) |
| `POST` | `/users/:id/role` | admin | Change a user's role |
| `POST` | `/users/:id/delete` | admin | Delete a user |
| `GET` | `/users/:id/reset` | admin | Page to generate a reset link for a user |
| `POST` | `/users/:id/reset` | admin | Generate a one-time reset link |
| `GET` | `/reset-password` | Public | Reset password page (token via query string) |
| `POST` | `/reset-password` | Public | Set a new password with a valid token |
| `GET` | `/change-password` | Required | Redirects to `/settings/account` |
| `POST` | `/change-password` | Required | Change own password |
| `GET` | `/play` | Public | Slide player view (add `?tags=name` for a single area) |
| `GET` | `/api/slides` | Public | Get active slides (JSON; add `?tags=name[,name]` to filter to a tag group plus general slides) |
| `GET` | `/api/tags` | admin, contributor | List tags with slide counts |
| `POST` | `/api/tags` | admin, contributor | Create a tag (`name`) |
| `PUT` | `/api/tags/:id` | admin, contributor | Rename a tag (`name`) |
| `DELETE` | `/api/tags/:id` | admin, contributor | Delete a tag (removes it from every slide) |
| `POST` | `/api/update-slides` | admin, contributor | Update slide order, duration, transitions, active state, schedules, and tags |
| `POST` | `/api/upload` | admin, contributor | Upload images (multipart form, field: `images`) |
| `DELETE` | `/api/slides/:id` | admin, contributor | Delete a slide |
