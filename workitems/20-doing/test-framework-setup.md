---
id: test-framework-setup
title: Set up Vitest for unit/component testing
status: doing
priority: low
created: 2026-06-07
updated: 2026-06-14
completed:
target_release: next
estimate: M
risk: low
tags: [dev-env, testing, vitest, unit-tests]
owner: pi
---

# Set up Vitest for unit/component testing

## Summary

Set up Vitest as the unit/component test framework for both backend (Node.js ESM) and frontend (Vue 3 + Vite). Vitest is the recommended choice because it's Vite-native, fast, and works well with ESM.

## Acceptance Criteria

- [ ] Vitest is installed in both `backend/` and `frontend/`
- [ ] `backend/vitest.config.ts` is configured for Node.js ESM
- [ ] `frontend/vite.config.js` includes `@vitejs/plugin-vue` and Vitest config
- [ ] At least one smoke test exists in each (backend + frontend)
- [ ] `bun run test` (or `npm run test`) runs all tests
- [ ] Coverage reporting works

## Implementation Paths

### Path A — Vitest in both projects (recommended)
```bash
# Backend
cd backend && bun add -D vitest

# Frontend (already has Vite, Vitest is compatible)
cd frontend && bun add -D vitest @vue/test-utils jsdom
```

**Pros:** Single test framework for both, fast, Vite-native
**Cons:** Requires config setup

### Path B — Separate frameworks per layer
- Backend: Vitest
- Frontend: Vitest + Vue Test Utils

**Pros:** Framework-specific optimizations
**Cons:** More complexity, two test runners

## Test Plan

- Run `bun run test` in backend — smoke test passes
- Run `bun run test` in frontend — smoke test passes
- Run `bun run test --coverage` — coverage report generated
- Verify tests run in watch mode: `bun run test --watch`

## Definition of Done

- [ ] All acceptance criteria satisfied and verified
- [ ] Vitest runs in both backend and frontend
- [ ] At least one passing test in each
- [ ] Coverage reporting works
- [ ] Update history complete with evidence
- [ ] Quality score ≥ 9 recorded in final update
- [ ] Ticket front matter updated (`status`, `updated`, `completed`)
- [ ] Ticket moved to `50-done/`

## Updates

### 2026-06-07
- Created in inbox as part of dev environment setup workitems

## Notes

- **Low priority** — user tests manually and features are working
- This is about setting up the infrastructure, not writing comprehensive tests
- Existing manual testing provides a good reference for what to test
- Consider migrating from `test-ui.js` (Playwright script) to proper Playwright test files (see `playwright-setup`)

## Links

- Related: `playwright-setup`
