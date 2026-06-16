---
id: frontend-env-config
title: Configure frontend .env for local development
status: 20-doing
priority: high
created: 2026-06-07
updated: 2026-06-08
completed:
target_release: next
estimate: S
risk: low
tags: [dev-env, setup, configuration]
owner: pi
---

# Configure frontend .env for local development

## Summary

Update `frontend/.env` for local development. The Vite dev server needs to proxy API and WebSocket requests to the backend on port 3000.

## Current state

The existing `frontend/.env` has:
```
AUTH_KEYCLOAK_URL=https://auth.klucsik.hu
AUTH_KEYCLOAK_REALM=home
AUTH_KEYCLOAK_CLIENT_ID=test_rpg_wiki
AUTH_KEYCLOAK_CLIENT_SECRET=<secret>
VITE_KEYCLOAK_REDIRECT_URI=http://localhost:5173/callback
```

But it's missing/needs:
- `VITE_API_URL` — should be empty (same origin) or set to `http://localhost:3000`
- `VITE_WS_URL` — should be empty (auto-detect) or set to `ws://localhost:3000`

## Acceptance Criteria

- [ ] `frontend/.env` has correct API and WebSocket URLs for dev
- [ ] `VITE_KEYCLOAK_REDIRECT_URI=http://localhost:5173/callback` (matches Vite dev server port)
- [ ] Frontend dev server (`npm run dev` / `vite`) starts and loads at `http://localhost:5173`
- [ ] Vite proxy correctly forwards `/api/*` and `/socket.io/*` to backend `http://localhost:3000`
- [ ] Login button appears and attempts OIDC redirect to `auth.klucsik.hu`

## Implementation Paths

### Path A — Same-origin proxy (recommended)
1. Keep `VITE_API_URL=` and `VITE_WS_URL=` empty
2. Vite's `proxy` config in `vite.config.js` already routes `/api`, `/audio`, `/socket.io` to `http://localhost:3000`
3. Frontend loads at `http://localhost:5173`, all API calls go through Vite proxy

**Pros:** Simple, single origin, no CORS issues, matches production-like setup
**Cons:** Backend must run first

### Path B — Explicit API URL
1. Set `VITE_API_URL=http://localhost:3000`
2. Set `VITE_WS_URL=ws://localhost:3000`
3. Remove Vite proxy config (not needed)

**Pros:** Explicit, no proxy magic
**Cons:** Potential CORS issues, different from production

## Test Plan

- Start backend on port 3000
- Start frontend dev server: `cd frontend && npm run dev`
- Open `http://localhost:5173` in browser
- Verify Vue app mounts (`#app` element present)
- Verify login button appears
- Click login — should redirect to `https://auth.klucsik.hu` with correct client ID
- After login, should redirect back to `http://localhost:5173/callback`

## Definition of Done

- [ ] All acceptance criteria satisfied and verified
- [ ] Frontend dev server starts and loads
- [ ] API proxy works (network tab shows requests going through Vite proxy to port 3000)
- [ ] WebSocket proxy works (Socket.io connection established)
- [ ] OIDC login flow reaches Keycloak
- [ ] Update history complete with evidence
- [ ] Quality score ≥ 9 recorded in final update
- [ ] Ticket front matter updated (`status`, `updated`, `completed`)
- [ ] Ticket moved to `50-done/`

## Updates

### 2026-06-07
- Created in inbox as part of dev environment setup workitems

## Notes

- Vite dev server runs on port 5173 by default
- `vite.config.js` already has proxy config for `/api`, `/audio`, `/socket.io`
- The `VITE_KEYCLOAK_REDIRECT_URI` in `.env` must match what Keycloak expects
- Blocker: need test user credentials to verify full login flow (see `oidc-auth-testing`)

## Links

- Related: `backend-env-config`, `oidc-auth-testing`
