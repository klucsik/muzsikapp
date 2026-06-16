---
id: setup-dev-env-overview
title: Development Environment Setup — Overview
status: 20-doing
priority: critical
created: 2026-06-07
updated: 2026-06-08
completed:
target_release: next
estimate: L
risk: low
tags: [dev-env, setup, meta]
owner: pi
---

# Development Environment Setup — Overview

## Summary

Meta-ticket for setting up a fully functional MuzsikApp development environment inside the Piclaw container. The app should be runnable, testable, and debuggable with hot-reload on both frontend and backend.

## Dependencies

- `install-deps` — install backend and frontend dependencies
- `backend-env-config` — configure backend .env for local dev
- `frontend-env-config` — configure frontend .env for local dev
- `monorepo-scripts` — create root package.json with dev/start scripts
- `dev-server-automation` — create reliable startup script for both services
- `playwright-setup` — install and configure Playwright for E2E testing

## Notes

- Container already has: Node.js 24, npm, npx, bun, ffmpeg, yt-dlp, Playwright browsers
- Playwright is installed in `frontend/node_modules/` but not globally — needs a proper setup
- OIDC auth uses Keycloak at `auth.klucsik.hu` — needs test user credentials
- Music library seeding will come later (manual download feature)
- Process management (pm2/supervisor) is a separate follow-up ticket

## Links

- Dockerfile: `utils/Dockerfile.muzsikapp-dev`
- Project: `src/muzsikapp/`
