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

Only m4a containers qualify — MP3/FLAC stays on the V1 player. It needs `ffmpeg` and `ffprobe` on
`PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`), and is safe to run while the server is up. Set
`NORMALIZE_ON_STARTUP=false` to skip the boot-time pass; the log then points back at this command.

## Project Structure

- `/frontend` - Vue.js frontend application
- `/backend` - Express.js API server
- `/k8s` - Kubernetes deployment manifests
