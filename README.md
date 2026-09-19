# MuzsikApp

A web-based music streaming application for managing and playing your personal music library for multiple clients.

## Features

- 🎵 Music library browser with search and sorting
- 📁 Folder-based organization
- 🎼 Playlist management
- 🔄 Real-time sync across multiple clients via WebSocket

## Tech Stack

- **Frontend**: Vue 3, Vite
- **Backend**: Node.js, Express
- **Database**: SQLite with better-sqlite3
- **Real-time**: Socket.io

## Quick Start

```bash
# Start the application
./start.sh
```

The application will be available at `http://localhost:3000`

## Development

```bash
# Frontend development
cd frontend
npm install
npm run dev

# Backend development
cd backend
npm install
npm start
```

Or you can use the provided `./start.sh` script to start both frontend and backend together.

## Preparing the library for the V2 player

The V2 player streams fragmented MP4. The backend converts tracks in place on startup, but this
runs the same pass by hand — before a first deploy, or to find out why one song still plays through
V1 (a track with no stored metadata answers its manifest with 415 and the UI falls back silently):

```bash
npm run v2convert -- --dry-run          # what would change, nothing written
npm run v2convert                       # convert in place
npm run v2convert -- --track song.m4a   # one track: id, filename or stored path
npm run v2convert -- --json             # one summary line for scripts; exit 1 on any failure
```

It needs `ffmpeg` and `ffprobe` on `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`), and is safe to run
while the server is up. Set `NORMALIZE_ON_STARTUP=false` to skip the boot-time pass; the log then
points back at this command.

### Re-encoding: `--transcode`

By default only m4a containers are touched — everything else is reported as `skipped` and plays on
the V1 player. `--transcode` adds formats that have to be **re-encoded** to reach fragmented MP4:
an mp3 becomes AAC in a fragmented container, and **the original file is deleted**.

```bash
npm run v2convert -- --transcode --dry-run    # see what would be replaced (nothing is written)
npm run v2convert -- --transcode --limit 5    # pilot a handful
npm run v2convert -- --transcode              # the rest
npm run v2convert -- --transcode --bitrate 160k
```

Lossy in, lossy out: ID3 tags and embedded artwork go with the source (artwork comes from the
database), and there is no way back. The encoder writes to a temp file, the result is scanned,
probed and length-checked before the row is moved, and a name already in use gets a `.v2` suffix
rather than being overwritten. Encoding is roughly 35× slower than a remux — about 5 s per 3-minute
track, so plan an hour of CPU for a thousand tracks and keep `--concurrency` near your core count.

This **never runs at startup**, whatever `NORMALIZE_ON_STARTUP` says: a deploy must not spend an
hour re-encoding a library by accident. Defaults live in `TRANSCODE_FORMATS` (default `mp3`),
`TRANSCODE_BITRATE` (default `192k`) and `TRANSCODE_TIMEOUT_MS` (default 15 min per track).

## Project Structure

- `/frontend` - Vue.js frontend application
- `/backend` - Express.js API server
- `/k8s` - Kubernetes deployment manifests
