---
id: process-management
title: Set up process management for dev services
status: inbox
priority: low
created: 2026-06-07
updated: 2026-06-07
completed:
target_release: next
estimate: M
risk: low
tags: [dev-env, infrastructure, process-management, pm2]
owner: pi
---

# Set up process management for dev services

## Summary

As a follow-up to the dev environment setup, create a robust process management solution for running the backend and frontend services. This is not needed for initial dev setup but would improve reliability for longer development sessions.

## Acceptance Criteria

- [ ] Both backend and frontend can be started/stopped independently
- [ ] Auto-restart on crash is configured
- [ ] Log files are managed (rotation, retention)
- [ ] Health checks are monitored

## Implementation Paths

### Path A — pm2
Install pm2 and create an ecosystem config:
```js
module.exports = {
  apps: [
    {
      name: 'muzsikapp-backend',
      script: 'backend/src/server.js',
      cwd: '/workspace/src/muzsikapp',
      instances: 1,
      exec_mode: 'fork',
      watch: true,
      ignore_watch: ['node_modules', 'public', '.git'],
      max_memory_restart: '1G',
    },
    {
      name: 'muzsikapp-frontend',
      script: 'frontend/node_modules/vite/bin/vite.js',
      cwd: '/workspace/src/muzsikapp',
      instances: 1,
      exec_mode: 'fork',
      watch: true,
      args: '--host',
      max_memory_restart: '512M',
    }
  ]
}
```

**Pros:** Battle-tested, great monitoring, log management, auto-restart
**Cons:** Extra dependency, overkill for simple dev

### Path B — Continue with tmux (current approach)
Use tmux sessions as the process manager.

**Pros:** Already available, simple
**Cons:** No auto-restart, manual log management

## Test Plan

- Start services with pm2/tmux
- Kill one service — verify auto-restart (pm2) or easy restart (tmux)
- Check logs — verify they are readable and rotated

## Definition of Done

- [ ] All acceptance criteria satisfied and verified
- [ ] Services can be managed with a single command
- [ ] Update history complete with evidence
- [ ] Quality score ≥ 9 recorded in final update
- [ ] Ticket front matter updated (`status`, `updated`, `completed`)
- [ ] Ticket moved to `50-done/`

## Updates

### 2026-06-07
- Created in inbox as a follow-up item — low priority, not blocking dev environment setup

## Notes

- This is explicitly requested as a separate ticket from the dev environment setup
- tmux-based startup (see `dev-server-automation`) is sufficient for initial dev work
- pm2 would be a nice-to-have for longer sessions or if services crash frequently

## Links

- Related: `dev-server-automation`
