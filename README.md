# DisplayDrop

A lightweight, self-contained digital signage application for image slideshows. Built with Express, SQLite, and vanilla JS.

## Features

- **Dashboard Control Panel** — Manage slides, set duration, transitions, and toggle visibility
- **Drag & Drop Upload** — Upload multiple images (JPG, PNG, GIF, WEBP) via drag-and-drop or file browser
- **Live File Sync** — Automatically detects images added or removed from the `public/slides/` folder
- **Slide Player** — Dedicated `/play` view with fullscreen support (double-click or press `F`)
- **Drag-to-Reorder** — Sortable table rows for quick playlist arrangement
- **Bulk Actions** — Apply duration and transition settings to all slides at once
- **Delete Slides** — Remove slides directly from the dashboard (deletes both DB entry and file)
- **Zero External DB Server** — Uses Node.js built-in `node:sqlite` with a local `displaydrop.db` file

## Getting Started

```bash
npm install
npm start
```

Open your browser to:
- Dashboard: http://localhost:3000
- Play View: http://localhost:3000/play

During development, use `npm run dev` for auto-restart on file changes.

## Configuration

- **Port**: Set `PORT` env variable (default: `3000`)
- **Slides Directory**: `public/slides/` — drop images here or use the dashboard uploader
- **Database**: `displaydrop.db` — auto-created on first run

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard |
| `GET` | `/play` | Slide player view |
| `GET` | `/api/slides` | Get active slides (JSON) |
| `POST` | `/api/update-slides` | Update slide order, duration, transitions, and active state |
| `POST` | `/api/upload` | Upload images (multipart form, field: `images`) |
| `DELETE` | `/api/slides/:id` | Delete a slide |
